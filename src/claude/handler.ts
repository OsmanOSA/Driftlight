import path from "node:path";
import { promises as fs } from "node:fs";
import { changeFromAbsolutePath, classifyCommand } from "../classification/rules.js";
import type { ClaudeHookInput, SessionEvent, SessionRecord } from "../domain/types.js";
import { loadConfigSync } from "../config/config.js";
import { captureGitBaseline, resolveObservableRoot } from "../git/baseline.js";
import { readCurrentIntentSync, writeCurrentIntent } from "../intent/current-intent.js";
import {
  extractDeclaredPlanPaths,
  extractReadPaths,
  isPlanTool,
  isReadLikeTool,
} from "../intent/agent-context.js";
import { diffSnapshots, scanRepository } from "../observer/snapshot.js";
import { updateImportGraph } from "../profile/import-graph.js";
import {
  askUserDecision,
  dismissPendingNotifications,
  dispatchNotifications,
  interactiveDecisionAvailable,
} from "../notify/dispatcher.js";
import { suppressedByCap } from "../notify/notified-log.js";
import { safeIdentifier } from "../shared/paths.js";
import { redactSensitiveText } from "../shared/redact.js";
import {
  appendSessionEvents,
  classifyProposedFileChange,
  createSession,
  eventFromFindings,
  processChanges,
  recordAgentRead,
  recordDeclaredPlanPaths,
  setCurrentIntent,
} from "../session/service.js";
import { SessionStore } from "../session/store.js";
import { recordCurrentStatus } from "../status/current-status.js";
import { formatStopSummary } from "../ui/terminal.js";
import { restoreTitleSequence, terminalTitleSequence } from "../ui/terminal-title.js";

export interface ClaudeHookOutput {
  systemMessage?: string;
  suppressOutput?: boolean;
  /**
   * Arrête l'agent, et pas seulement l'appel en cours.
   *
   * `permissionDecision: "deny"` ne retient qu'une commande : l'agent reprend
   * la main aussitôt et peut en tenter une autre. Observé en usage réel, cela
   * donne une succession de refus pendant que l'agent poursuit — indiscernable,
   * pour qui regarde l'écran, d'un garde-fou qu'on contourne. Or DriftLight
   * demande précisément à l'agent de ne pas insister et de rendre la main.
   *
   * `continue: false` l'impose au lieu de le demander. Réservé au refus ferme,
   * là où la perte serait définitive : ce champ prime sur toute décision par
   * événement, et coupe le tour en cours.
   */
  continue?: boolean;
  /** Motif affiché à l'utilisateur — et à lui seul — quand le tour est coupé. */
  stopReason?: string;
  /**
   * Séquence d'échappement que Claude Code émet lui-même vers le terminal.
   * Restreinte par Claude Code aux OSC 0/1/2/9/99/777 et BEL : toute séquence
   * hors allowlist fait ignorer le champ entier.
   */
  terminalSequence?: string;
  hookSpecificOutput?: {
    hookEventName: "PreToolUse";
    /**
     * `ask` remet la décision à l'utilisateur — mais l'agent hôte peut la
     * court-circuiter selon son mode de permission, et l'action se déroule alors
     * malgré l'alerte. `deny` refuse l'appel sans recours possible.
     */
    permissionDecision: "ask" | "deny";
    permissionDecisionReason: string;
    additionalContext: string;
  };
}

/**
 * Destruction que rien ne pourra défaire.
 *
 * L'étage 0 ne se déclenche qu'après avoir constaté, dans la baseline Git, des
 * modifications non sauvegardées sur le fichier visé : ni Git ni l'agent ne
 * sauront les restaurer. Une commande Git destructrice rejoint cette catégorie
 * uniquement s'il existe effectivement du travail préexistant à emporter — sans
 * quoi `git reset --hard` est sans conséquence et un refus ferme serait un
 * obstacle gratuit.
 */
function destroysUnrecoverableWork(event: SessionEvent, session: SessionRecord): boolean {
  if (event.stage === "absolute") return true;
  // Une suppression récursive dirigée vers le dépôt emporte exactement ce
  // qu'emporte une commande Git destructrice : ce qui n'est pas encore commité.
  // Les séparer n'avait pas de justification — `rm -rf src` laissait une simple
  // demande de confirmation, qu'un mode de permission permissif écarte sans
  // rien dire, alors que la perte est tout aussi définitive.
  const erasesUncommittedWork = event.ruleId === "destructive-git-command"
    || event.ruleId === "destructive-file-command";
  return erasesUncommittedWork && session.baseline.files.length > 0;
}

async function sessionContext(input: ClaudeHookInput): Promise<{
  store: SessionStore;
  session: SessionRecord | null;
  id: string;
  root: string;
}> {
  const baseline = await captureGitBaseline(input.cwd);
  const root = baseline.root;
  const id = `claude-${safeIdentifier(input.session_id)}`;
  const store = new SessionStore(root);
  return { store, session: await store.load(id), id, root };
}

function absoluteToolPath(root: string, filePath: string): string {
  return path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(root, filePath);
}

/**
 * Notifie les événements retenus. Purement additif — un échec ici ne doit jamais
 * empêcher le hook de rendre son verdict.
 *
 * `blockedEventIds` porte l'issue réelle du hook : seuls ces événements ont
 * effectivement suspendu l'action, et eux seuls seront annoncés comme bloqués.
 * `deniedEventIds` distingue le refus ferme de la simple demande, parce que les
 * deux n'engagent pas la même promesse envers l'utilisateur.
 */
async function signalEvents(
  session: SessionRecord,
  events: SessionEvent[],
  blockedEventIds: readonly string[] = [],
  deniedEventIds: readonly string[] = [],
): Promise<void> {
  try {
    await dispatchNotifications(session.cwd, events, loadConfigSync(session.cwd), session.id, {
      blockedEventIds,
      deniedEventIds,
    });
  } catch {
    // Couche de signalement optionnelle : on n'interrompt pas le hook.
  }
}

/**
 * Titre du terminal délégué à Claude Code, qui possède seul le chemin d'écriture
 * vers le terminal réel. Un hook n'a pas de terminal de contrôle.
 */
function titleOutput(root: string): ClaudeHookOutput | undefined {
  const sequence = terminalTitleSequence(root, loadConfigSync(root));
  return sequence ? { terminalSequence: sequence } : undefined;
}

function textLineCount(value: string): number {
  if (value.length === 0) return 0;
  return value.split(/\r?\n/).length - (value.endsWith("\n") ? 1 : 0);
}

async function proposedOperationContext(
  toolName: string,
  absolutePath: string,
  toolInput: Record<string, unknown>,
): Promise<{ content?: string; fullFileReformat?: boolean }> {
  if (toolName === "Write" && typeof toolInput.content === "string") {
    try {
      const current = await fs.readFile(absolutePath, "utf8");
      const compact = (value: string): string => value.replace(/\s+/g, "");
      return {
        content: toolInput.content,
        fullFileReformat: current !== toolInput.content && compact(current) === compact(toolInput.content),
      };
    } catch {
      return { content: toolInput.content };
    }
  }
  if (toolName !== "Edit" || typeof toolInput.old_string !== "string" || typeof toolInput.new_string !== "string") {
    return {};
  }
  try {
    const current = await fs.readFile(absolutePath, "utf8");
    return current.includes(toolInput.old_string)
      ? { content: current.replace(toolInput.old_string, toolInput.new_string), fullFileReformat: false }
      : { fullFileReformat: false };
  } catch {
    return { fullFileReformat: false };
  }
}

async function ensureSession(input: ClaudeHookInput): Promise<{ store: SessionStore; session: SessionRecord }> {
  const context = await sessionContext(input);
  if (context.session) return { store: context.store, session: context.session };
  const session = await createSession({
    cwd: context.root,
    source: "claude-code",
    id: context.id,
    externalId: input.session_id,
  });
  await context.store.save(session);
  return { store: context.store, session };
}

export async function handleClaudeHook(input: ClaudeHookInput): Promise<ClaudeHookOutput | undefined> {
  if (!input.session_id || !input.cwd || !input.hook_event_name) return undefined;
  // Installé globalement, le hook se déclenche dans tous les projets ouverts.
  // Hors dépôt Git, DriftLight se tait entièrement plutôt que d'observer un
  // périmètre qu'il ne sait pas délimiter.
  if (await resolveObservableRoot(input.cwd) === null) return undefined;

  if (input.hook_event_name === "SessionStart") {
    const context = await sessionContext(input);
    let session = context.session;
    if (!session || input.source === "startup" || input.source === "clear") {
      session = await createSession({
        cwd: context.root,
        source: "claude-code",
        id: context.id,
        externalId: input.session_id,
      });
      await context.store.save(session);
    }
    if (input.source === "startup" || input.source === "clear") {
      await writeCurrentIntent(context.root, "", {
        turnId: `session-${input.session_id}`,
        resetScope: true,
        sessionId: context.id,
      });
    }
    return titleOutput(context.root);
  }

  const { store, session } = await ensureSession(input);

  // Toute alerte encore affichée attendait une décision. Ces trois événements
  // signifient qu'elle a été prise — l'outil a tourné, le tour s'est achevé, ou
  // un nouveau prompt est arrivé. La notification n'a plus rien à demander.
  if (["PostToolUse", "Stop", "UserPromptSubmit", "SessionEnd"].includes(input.hook_event_name)) {
    await dismissPendingNotifications(session.cwd, session.id).catch(() => []);
  }

  if (input.hook_event_name === "UserPromptSubmit") {
    if (input.prompt) {
      setCurrentIntent(session, input.prompt, "user-follow-up");
      await writeCurrentIntent(session.cwd, input.prompt, { turnId: input.prompt_id, sessionId: session.id });
    }
    await store.save(session);
    return undefined;
  }

  if (input.hook_event_name === "PreToolUse") {
    const events: SessionEvent[] = [];
    if (input.tool_name && isPlanTool(input.tool_name)) {
      const intent = readCurrentIntentSync(session.cwd, session.id);
      if (intent) {
        recordDeclaredPlanPaths(
          session,
          intent.turnId,
          extractDeclaredPlanPaths(session.cwd, input.tool_input),
        );
      }
    }
    const command = input.tool_input?.command;
    if ((input.tool_name === "Bash" || input.tool_name === "PowerShell") && typeof command === "string") {
      // L'intention entre dans la classification des commandes : supprimer ce
      // que l'utilisateur vient de demander ne doit pas produire d'alerte.
      const currentIntent = readCurrentIntentSync(session.cwd, session.id);
      const findings = classifyCommand(
        command,
        session.baseline,
        undefined,
        currentIntent ? { text: currentIntent.text, scopeAdditions: currentIntent.scopeAdditions } : undefined,
      );
      if (findings.length > 0) {
        // La classification voit la commande telle quelle ; ce qui est conservé
        // et réaffiché est expurgé. Un jeton passé en argument finirait sinon
        // en clair dans l'historique de session, sur le disque, et dans le
        // message rendu à l'agent.
        const event = eventFromFindings(
          "proposed-action",
          findings,
          session.cwd,
          redactSensitiveText(command).slice(0, 160),
        );
        const intent = currentIntent;
        if (intent) {
          event.intentVersion = intent.version;
          event.turnId = intent.turnId;
        }
        events.push(event);
      }
    }

    const rawPath = input.tool_input?.file_path;
    if (typeof rawPath === "string" && ["Edit", "Write", "NotebookEdit"].includes(input.tool_name ?? "")) {
      const absolutePath = absoluteToolPath(session.cwd, rawPath);
      const kind = session.lastSnapshot.files[changeFromAbsolutePath(session.cwd, absolutePath, "modified")?.path ?? ""]
        ? "modified"
        : "created";
      const oldText = input.tool_input?.old_string;
      const newText = input.tool_input?.new_string;
      const writtenText = input.tool_input?.content;
      const relativePath = changeFromAbsolutePath(session.cwd, absolutePath, kind)?.path;
      const deletedLineCount = input.tool_name === "Write" && typeof writtenText === "string"
        ? Math.max(0, (relativePath ? session.lastSnapshot.files[relativePath]?.lineCount ?? 0 : 0) - textLineCount(writtenText))
        : typeof oldText === "string" && typeof newText === "string"
          ? Math.max(0, textLineCount(oldText) - textLineCount(newText))
          : 0;
      const operation = input.tool_name === "Write" ? "write" : "edit";
      const proposed = await proposedOperationContext(input.tool_name ?? "", absolutePath, input.tool_input ?? {});
      const event = classifyProposedFileChange(
        session,
        absolutePath,
        kind,
        operation,
        deletedLineCount,
        proposed.content,
        proposed.fullFileReformat,
      );
      if (event) events.push(event);
    }

    const acceptedEvents = appendSessionEvents(session, events);
    recordCurrentStatus(session.cwd, acceptedEvents);
    await store.save(session);

    // Le refus est décidé avant toute notification : le libellé annoncé à
    // l'utilisateur doit refléter l'issue réelle du hook, pas la sévérité seule.
    const config = loadConfigSync(session.cwd);
    const blockingEvent = acceptedEvents.find((event) => event.level === "RED" && config.blockOnRed)
      ?? acceptedEvents.find((event) => event.level === "ORANGE" && config.blockOnOrange);

    // Un refus ferme n'est pas une demande plus insistante : il ne laisse aucune
    // issue à l'agent. Il est réservé aux cas où se tromper coûte moins cher
    // qu'une perte définitive, ou à une décision explicite de l'utilisateur.
    const denied = blockingEvent !== undefined && blockingEvent.level === "RED" && (
      config.enforceRed === "always"
      || (config.enforceRed === "irreversible" && destroysUnrecoverableWork(blockingEvent, session))
    );

    // Quand l'utilisateur peut être consulté, le panneau *est* la notification :
    // la dispatcher en plus en afficherait deux pour la même alerte.
    const asking = denied && blockingEvent !== undefined && interactiveDecisionAvailable();
    await signalEvents(
      session,
      asking ? acceptedEvents.filter((event) => event.id !== blockingEvent.id) : acceptedEvents,
      blockingEvent && !asking ? [blockingEvent.id] : [],
      denied && blockingEvent && !asking ? [blockingEvent.id] : [],
    );

    // Le hook se suspend ici, comme le fait la fenêtre de permission de l'agent
    // hôte. C'est ce qui distingue une retenue d'un arrêt : l'action attend une
    // réponse, et l'agent repart de lui-même dès qu'elle tombe — sans que
    // personne ait à le relancer.
    const answer = asking && blockingEvent
      ? await askUserDecision(session.cwd, blockingEvent, config, session.id)
      : undefined;

    const title = titleOutput(session.cwd);
    if (answer === "allow") return title;

    if (!blockingEvent) return title;
    const subject = blockingEvent.path ?? blockingEvent.detail ?? "action";
    const reason = blockingEvent.reasons[0] ?? blockingEvent.ruleId;
    const message = `DriftLight ${blockingEvent.level} — ${subject} — ${blockingEvent.ruleId}: ${reason} [${blockingEvent.id}]`;
    // L'arrêt du tour n'est plus qu'un dernier recours : il n'existe que là où
    // l'utilisateur n'a pas pu être consulté — hors de Windows, ou notifications
    // coupées. Refuser sans pouvoir demander laisserait sinon l'agent enchaîner
    // sur autre chose pendant que l'utilisateur regarde passer des refus.
    const halt = denied && config.haltOnRefusal && answer === undefined;
    return {
      ...title,
      suppressOutput: true,
      ...(halt
        ? {
          continue: false,
          stopReason: `DriftLight a refusé cette action : ${subject}.`
            + " L'agent est arrêté et la décision vous revient."
            + " Pour l'autoriser : `driftlight add-scope \"<chemin ou instruction>\"`,"
            + ` puis redemandez-la. Détail : \`driftlight explain ${blockingEvent.id}\`.`,
        }
        : {}),
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: denied ? "deny" : "ask",
        permissionDecisionReason: message,
        additionalContext: denied
          // Refuser sans dire comment procéder légitimement transformerait la
          // protection en impasse : l'agent doit savoir qu'une voie existe.
          ? `${message}. Action refusée par DriftLight. N'insiste pas et ne contourne pas :`
            + " demande à l'utilisateur de confirmer explicitement, ou de l'autoriser via"
            + " `driftlight add-scope \"<chemin ou instruction>\"`."
          : `${message}. Attends la confirmation explicite de l'utilisateur avant de poursuivre cette action.`,
      },
    };
  }

  if (input.hook_event_name === "PostToolUse" || input.hook_event_name === "FileChanged") {
    if (input.hook_event_name === "PostToolUse" && input.tool_name && isReadLikeTool(input.tool_name)) {
      const intent = readCurrentIntentSync(session.cwd, session.id);
      const paths = extractReadPaths(
        session.cwd,
        input.tool_input,
        input.tool_response,
        Object.keys(session.lastSnapshot.files),
      );
      if (intent) {
        for (const filePath of paths) recordAgentRead(session, filePath, intent.turnId);
      }
      await store.save(session);
      return undefined;
    }
    const current = await scanRepository(session.cwd);
    const changes = diffSnapshots(session.lastSnapshot, current);
    await updateImportGraph(session.cwd, current, changes).catch(() => null);
    const events = processChanges(session, changes, current);
    await store.save(session);
    // PostToolUse observe le disque après coup : rien n'a été bloqué ici.
    await signalEvents(session, events);
    return titleOutput(session.cwd);
  }

  if (input.hook_event_name === "Stop") {
    const intent = readCurrentIntentSync(session.cwd, session.id);
    if (!intent) return undefined;
    const summary = formatStopSummary(
      session.events,
      intent.turnId,
      suppressedByCap(session.cwd, session.id),
    );
    return summary ? { systemMessage: summary, suppressOutput: true } : undefined;
  }

  if (input.hook_event_name === "SessionEnd") {
    session.endedAt = new Date().toISOString();
    const lifecycle = eventFromFindings("lifecycle", [], session.cwd, `Session Claude Code terminée : ${input.reason ?? "other"}`);
    lifecycle.reasons = ["Session terminée, historique local enregistré."];
    session.events.push(lifecycle);
    await store.save(session);
    const restored = restoreTitleSequence(session.cwd, loadConfigSync(session.cwd));
    return restored ? { terminalSequence: restored } : undefined;
  }

  return undefined;
}
