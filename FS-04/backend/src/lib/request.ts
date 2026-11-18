import type { Membership, User, Workspace } from "../generated/prisma/client.js";

// What the middleware attaches to a request: the signed-in user, and for tenant routes the workspace + membership.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
      workspace?: Workspace;
      membership?: Membership;
    }
  }
}

export {};
