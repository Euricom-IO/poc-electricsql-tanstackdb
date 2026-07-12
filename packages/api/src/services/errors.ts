import type { ContentfulStatusCode } from 'hono/utils/http-status';

/**
 * A terminal, client-facing error raised by a mutation service. Both the REST
 * routes and the events endpoint catch it and turn it into a `{ error }` JSON
 * response with the given status — so the offline client dead-letters the
 * command instead of retrying it forever.
 */
export class ServiceError extends Error {
  constructor(
    public status: ContentfulStatusCode,
    message: string,
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}
