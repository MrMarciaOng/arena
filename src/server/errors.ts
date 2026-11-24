export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly headers?: Record<string, string>,
  ) {
    super(message);
  }
}

export const unauthorized = (message = "missing or invalid credentials") =>
  new ApiError(401, "unauthorized", message);
export const forbidden = (message = "this credential can't do that") =>
  new ApiError(403, "forbidden", message);
export const notFound = (what: string) => new ApiError(404, "not_found", `${what} not found`);
export const conflict = (message: string) => new ApiError(409, "conflict", message);
