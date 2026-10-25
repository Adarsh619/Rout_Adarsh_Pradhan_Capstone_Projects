import { createContext, useContext } from "react";

export const WorkspaceContext = createContext(null);
export const useWorkspace = () => useContext(WorkspaceContext);

const RANK = { viewer: 0, member: 1, admin: 2, owner: 3 };
export const can = (role, minimum) => (RANK[role] ?? -1) >= RANK[minimum];
