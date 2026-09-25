import { getPath, parsePath, type Step } from "./field";

export const ROLES = [
  "id",
  "key",
  "text",
  "author",
  "time",
  "replyTo",
  "replyAuthor",
  "quote",
  "quoteAuthor",
  "quoteId",
  "thread",
  "media",
  "repost",
] as const;
export type Role = (typeof ROLES)[number];

export const FLAG_OF: Partial<Record<Role, string>> = {
  id: "--id",
  text: "--text",
  author: "--author",
  time: "--time",
  replyTo: "--reply-to",
  quote: "--quote",
};

export const CANDIDATES: Record<Role, string[]> = {
  id: ["url", "permalink", "link", "tweet_url", "tweetUrl"],
  key: ["id", "id_str", "tweet_id", "tweetId", "message_id", "messageId"],
  text: ["text", "full_text", "fullText", "txt", "content", "body", "message"],
  author: ["author", "handle", "username", "screen_name", "screenName", "user"],
  time: ["created_at", "createdAt", "time", "timestamp", "date"],
  replyTo: [
    "reply_to_id",
    "replyToId",
    "in_reply_to_id",
    "inReplyToId",
    "in_reply_to_status_id",
    "parent_id",
    "parentId",
  ],
  replyAuthor: ["reply_to_author", "replyToAuthor", "inReplyToHandle", "in_reply_to_screen_name"],
  quote: ["quoted_text", "quotedText", "quoted", "quote_text", "quoteText"],
  quoteAuthor: ["quoted_author", "quotedAuthor", "quotedHandle", "quoted_handle"],
  quoteId: ["quoted_id", "quotedId", "quoted_status_id"],
  thread: ["thread_root_id", "threadRootId", "conversation_id", "conversationId", "thread_id"],
  media: ["media", "attachments"],
  repost: ["isRT", "is_retweet", "isRetweet", "is_repost"],
};

const NESTED_AUTHOR = ["handle", "username", "screen_name", "screenName", "login", "name"];
const TEXTUAL: ReadonlySet<Role> = new Set([
  "text",
  "author",
  "time",
  "quote",
  "quoteAuthor",
  "replyAuthor",
]);

export type RolePath = { path: string; steps: Step[]; from: "flag" | "detected"; present: number };
export type Roles = Partial<Record<Role, RolePath>>;

const present = (v: unknown) => v !== undefined && v !== null && v !== "" && v !== false;

function detect(role: Role, items: Record<string, unknown>[]): string | undefined {
  for (const name of CANDIDATES[role]) {
    const has = (it: Record<string, unknown>) => Object.prototype.hasOwnProperty.call(it, name);
    const holder = items.find((it) => has(it) && present(it[name])) ?? items.find(has);
    if (!holder) continue;
    const value = holder[name];
    if (role === "author" && typeof value === "object" && value !== null && !Array.isArray(value)) {
      const inner = NESTED_AUTHOR.find(
        (k) => typeof (value as Record<string, unknown>)[k] === "string",
      );
      if (inner) return `.${name}.${inner}`;
      continue;
    }
    if (TEXTUAL.has(role) && typeof value === "object") continue;
    return `.${name}`;
  }
  return undefined;
}

export function resolveRoles(
  items: Record<string, unknown>[],
  flags: Partial<Record<Role, string>>,
  autodetect: boolean,
): Roles {
  const roles: Roles = {};
  for (const role of ROLES) {
    const flagged = flags[role];
    const path = flagged ?? (autodetect ? detect(role, items) : undefined);
    if (path === undefined) continue;
    const steps = parsePath(path, FLAG_OF[role] ?? role);
    const count = items.filter((it) => present(getPath(it, steps))).length;
    roles[role] = {
      path,
      steps,
      from: flagged === undefined ? "detected" : "flag",
      present: count,
    };
  }
  if (!roles.id && roles.key) roles.id = { ...roles.key, from: "detected" };
  return roles;
}

const LABEL: Record<Role, string> = {
  id: "id",
  key: "key",
  text: "text",
  author: "author",
  time: "time",
  replyTo: "reply-to",
  replyAuthor: "reply-to author",
  quote: "quote",
  quoteAuthor: "quote author",
  quoteId: "quote id",
  thread: "thread",
  media: "media",
  repost: "repost",
};

export function describeRoles(roles: Roles, total: number): string {
  const parts = ROLES.filter((r) => roles[r]).map((r) => {
    const rp = roles[r]!;
    const where = rp.present === total ? "" : ` (${rp.present})`;
    return `${LABEL[r]} ${rp.path}${where}`;
  });
  return parts.length === 0 ? "none: every field is shown as key: value" : parts.join(" · ");
}

export function rolePaths(roles: Roles): string[] {
  return ROLES.flatMap((r) => (roles[r] ? [roles[r]!.path] : []));
}
