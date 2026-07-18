/** Session / turn pure surface for the desktop shell (#146). */

export type { ChatSession, PaneId, UiScale, Msg, MessageMetaDto } from "./types";
export { formatMsgMetaFooter, snapshotMessageMeta } from "./meta";
export {
  nowIso,
  newSession,
  isPlaceholderTitle,
  titleFromPrompt,
  msgFromStored,
  sessionFromDto,
  sessionToDto,
  foldPreview,
} from "./dto";
export {
  applyEventsToMessage,
  shortSourceLabel,
  type ChatMsg,
} from "../turn";
