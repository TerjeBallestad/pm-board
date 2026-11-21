// The 1.x read API answers with 0.x's JSON (server/Boards/V0Json.cs), so these are 0.x's shapes.

export interface Comment {
  id: string;
  author?: string;
  text: string;
  createdAt?: string;
}

export interface Item {
  id: string;
  type: string;
  title: string;
  stage?: string;
  status?: string;
  priority?: string | null;
  body?: string;
  blockedBy?: string[];
  sprintId?: string | null;
  assignee?: string | null;
  assignedAt?: string | null;
  related?: string[];
  affectedFiles?: string[];
  aliases?: string[];
  comments?: Comment[];
  tests?: TestEntry[];
  createdAt?: string;
  updatedAt?: string;
  doneAt?: string;
  archivedAt?: string;
}

export interface TestEntry {
  name?: string;
  file?: string;
  claims?: { text?: string; method?: string }[];
}

export interface Design {
  id: string;
  title: string;
  stage?: string;
  body?: string;
  sprintId?: string | null;
  itemIds?: string[];
  linkedItems?: string[];
  tests?: TestEntry[];
  comments?: Comment[];
  createdAt?: string;
  updatedAt?: string;
}

export interface Task {
  id: string;
  title?: string;
  status?: string;
  passes?: boolean;
  description?: string;
  steps?: string | string[];
  verification?: string;
  blockedBy?: (string | number)[];
  progressNotes?: { text: string; timestamp?: string }[];
}

export interface Plan {
  id: string;
  title: string;
  stage?: string;
  sprintId?: string | null;
  sddId?: string | null;
  context?: { setupNotes?: string; relevantFiles?: string[]; designDecisions?: string | string[] } | string;
  tasks?: Task[];
  comments?: Comment[];
  createdAt?: string;
  updatedAt?: string;
}

/** A project: a SPRINT-NNN record inside a board (DD-015). */
export interface Sprint {
  id: string;
  name: string;
  problemStatement?: string;
  body?: string;
  status?: string;
  comments?: Comment[];
  createdAt?: string;
  completedAt?: string | null;
}

export interface EntityTypeMeta {
  label?: string;
  color?: string;
  frontier?: boolean;
  sweep?: boolean;
}

export interface BoardConfig {
  name: string;
  stages: string[];
  entityTypes: Record<string, EntityTypeMeta>;
  commands: { ticket?: Record<string, string>; sdd?: string; plan?: string; project?: string };
  claimTtlHours?: number;
}

export interface BoardSummary {
  slug: string;
  name: string;
}

export class NotFound extends Error {}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, { signal, headers: { Accept: 'application/json' } });
  if (res.status === 404) throw new NotFound(path);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export const api = {
  boards: (signal?: AbortSignal) => get<BoardSummary[]>('/api/boards', signal),
  config: (slug: string, signal?: AbortSignal) => get<BoardConfig>(`/api/boards/${slug}/config`, signal),
  items: (slug: string, signal?: AbortSignal) => get<Item[]>(`/api/boards/${slug}/items`, signal),
  archived: (slug: string, signal?: AbortSignal) => get<Item[]>(`/api/boards/${slug}/items/archived`, signal),
  designs: (slug: string, signal?: AbortSignal) => get<Design[]>(`/api/boards/${slug}/designs`, signal),
  plans: (slug: string, signal?: AbortSignal) => get<Plan[]>(`/api/boards/${slug}/plans`, signal),
  sprints: (slug: string, signal?: AbortSignal) => get<Sprint[]>(`/api/boards/${slug}/sprints`, signal),
  one: <T>(slug: string, entity: string, id: string) => get<T>(`/api/boards/${slug}/${entity}s/${encodeURIComponent(id)}`),
  eventsUrl: (slug: string) => `/api/boards/${slug}/events`,
};
