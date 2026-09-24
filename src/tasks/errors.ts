/**
 * The error codes of tau. A tool gives the code and the message to the model,
 * so each message tells what is wrong and what to do.
 */
export type TauErrorCode =
  | "invalid_argument"
  | "not_found"
  | "permission_denied"
  | "invalid_state"
  | "dependencies_not_complete"
  | "busy"
  | "storage";

export class TauError extends Error {
  override readonly name = "TauError";
  readonly code: TauErrorCode;

  constructor(code: TauErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}
