import type { ComponentProps } from "react";
import { ChatArchivePane } from "../panes/ChatArchivePane";
import {
  CompositionPane,
  type CompositionTarget,
} from "../panes/CompositionPane";
import { MemoryPane, type MemoryDoc } from "../panes/MemoryPane";
import { LogPane } from "../panes/LogPane";
import { InvestigationsPane } from "../panes/InvestigationsPane";
import { HarvestPane } from "../panes/HarvestPane";
import { HelpPane } from "../panes/HelpPane";
import { SourcePreviewPane } from "../panes/SourcePreviewPane";
import { TodoPane } from "../panes/TodoPane";
import { ChatPane, type ChatPaneProps } from "./ChatPane";
import { PaneTabs } from "./PaneTabs";
import type { PaneId } from "../../lib/session";
import type { HelpOpenRequest } from "../../lib/help";

type ArchiveProps = ComponentProps<typeof ChatArchivePane>;

type Props = {
  pane: PaneId;
  onPaneChange: (p: PaneId) => void;
  archive: ArchiveProps | null;
  chat: ChatPaneProps | null;
  memory: {
    docs: MemoryDoc[];
    activePath: string | null;
    onSelect: (p: string) => void;
    onCreateHint: () => void;
    onSave: (path: string, body: string) => void;
    onFilterChange?: (opts: {
      kind: string | null;
      includeSuperseded: boolean;
    }) => void;
    onCompose?: (doc: MemoryDoc) => void;
  } | null;
  compose: {
    target: CompositionTarget | null;
    onChangeTarget: (t: CompositionTarget) => void;
    onSave: (t: CompositionTarget) => Promise<void>;
    onOpenMemory?: (sourceId: string) => void;
    onBrowseMemory?: () => void;
    busy?: boolean;
    note?: string | null;
  } | null;
  source: { path: string | null; content: string } | null;
  todosKey: string | null;
  helpRequest?: HelpOpenRequest | null;
  onOpenHelp?: (pageId: string) => void;
};

/** Workspace pane host (#146). */
export function Workspace({
  pane,
  onPaneChange,
  archive,
  chat,
  memory,
  compose,
  source,
  todosKey,
  helpRequest,
  onOpenHelp,
}: Props) {
  return (
    <div className="workspace">
      <PaneTabs pane={pane} onChange={onPaneChange} />
      {pane === "archive" && archive ? (
        <div
          role="tabpanel"
          id="pane-panel-archive"
          aria-labelledby="pane-tab-archive"
          className="pane-panel"
        >
          <ChatArchivePane {...archive} />
        </div>
      ) : null}
      {pane === "chat" && chat ? <ChatPane {...chat} /> : null}
      {pane === "memory" && memory ? (
        <div
          role="tabpanel"
          id="pane-panel-memory"
          aria-labelledby="pane-tab-memory"
          className="pane-panel"
        >
          <MemoryPane {...memory} onOpenHelp={onOpenHelp} />
        </div>
      ) : null}
      {pane === "compose" && compose ? (
        <div
          role="tabpanel"
          id="pane-panel-compose"
          aria-labelledby="pane-tab-compose"
          className="pane-panel"
        >
          <CompositionPane {...compose} />
        </div>
      ) : null}
      {pane === "source" && source ? (
        <div
          role="tabpanel"
          id="pane-panel-source"
          aria-labelledby="pane-tab-source"
          className="pane-panel"
        >
          <SourcePreviewPane path={source.path} content={source.content} />
        </div>
      ) : null}
      {pane === "logs" ? (
        <div
          role="tabpanel"
          id="pane-panel-logs"
          aria-labelledby="pane-tab-logs"
          className="pane-panel"
        >
          <LogPane onOpenHelp={onOpenHelp} />
        </div>
      ) : null}
      {pane === "investigations" ? (
        <div
          role="tabpanel"
          id="pane-panel-investigations"
          aria-labelledby="pane-tab-investigations"
          className="pane-panel"
        >
          <InvestigationsPane onOpenHelp={onOpenHelp} />
        </div>
      ) : null}
      {pane === "harvest" ? (
        <div
          role="tabpanel"
          id="pane-panel-harvest"
          aria-labelledby="pane-tab-harvest"
          className="pane-panel"
        >
          <HarvestPane />
        </div>
      ) : null}
      {pane === "todos" && todosKey ? (
        <div
          role="tabpanel"
          id="pane-panel-todos"
          aria-labelledby="pane-tab-todos"
          className="pane-panel"
        >
          <TodoPane storageKey={todosKey} />
        </div>
      ) : null}
      {pane === "help" ? (
        <div
          role="tabpanel"
          id="pane-panel-help"
          aria-labelledby="pane-tab-help"
          className="pane-panel"
        >
          <HelpPane request={helpRequest} />
        </div>
      ) : null}
    </div>
  );
}
