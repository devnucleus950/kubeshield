// One error shape for every failure: { error: { code, message, issues? } }.
// Throw an HttpError anywhere; the error handler turns it into that shape.
export interface Issue {
  index?: number; // position in the array, when a batch was sent
  path: string;
  message: string;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly issues?: Issue[],
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'HttpError';
  }
}
