interface Person {
  id: string;
  login: string;
  name: string;
}
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const identityId = /(?:^|_)(?:user|broadcaster|moderator|sender)_id$/;
const identityLogin = /(?:^|_)login$/;
const identityName = /(?:^|_)(?:user_name|display_name)$/;
const identifier = /(?:^id$|_id$)/;
const prose = /^(?:text|user_input|system_message|prompt|title|message_body)$/;
const escapePattern = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function anonymizeRecording(
  source: string,
  options: { replaceText?: boolean } = {},
): string {
  const records = source
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line, index): unknown => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`Invalid recording JSON on line ${index + 1}`);
      }
    });
  const people = new Map<string, Person>();
  const replacements = new Map<string, string>();
  const ids = new Map<string, string>();
  let sequence = 0;
  const personFor = (raw: string) => {
    let person = people.get(raw);
    if (!person) {
      const number = ++sequence;
      person = {
        id: String(9_000_000_000 + number),
        login: `viewer${String(number).padStart(2, "0")}`,
        name: `Viewer ${String(number).padStart(2, "0")}`,
      };
      people.set(raw, person);
    }
    return person;
  };
  function visit(value: unknown, callback: (item: ObjectValue) => void): void {
    if (Array.isArray(value)) {
      for (const child of value) visit(child, callback);
    } else if (object(value)) {
      callback(value);
      for (const child of Object.values(value)) visit(child, callback);
    }
  }
  // Resolve identity groups before replacing free text, including nested shared-chat and notice data.
  for (const value of records)
    visit(value, (item) => {
      for (const [key, raw] of Object.entries(item)) {
        if (!identityId.test(key) || typeof raw !== "string" || !raw) continue;
        const person = personFor(raw);
        replacements.set(raw, person.id);
        const stem = key.slice(0, -2);
        for (const suffix of ["login", "name"] as const) {
          const alias = item[stem + suffix];
          if (typeof alias === "string" && alias) {
            people.set(alias, person);
            replacements.set(alias, person[suffix]);
          }
        }
      }
    });
  for (const value of records)
    visit(value, (item) => {
      for (const [key, raw] of Object.entries(item)) {
        if (Array.isArray(raw) && /_ids$/.test(key)) {
          for (const value of raw) {
            if (typeof value !== "string" || !value) continue;
            if (/user_ids$/.test(key)) replacements.set(value, personFor(value).id);
            else {
              if (!ids.has(value))
                ids.set(value, `local-id-${String(ids.size + 1).padStart(6, "0")}`);
              replacements.set(value, ids.get(value) ?? "");
            }
          }
        }
        if (typeof raw !== "string" || !raw) continue;
        if (identityLogin.test(key) || identityName.test(key)) {
          const person = personFor(raw);
          replacements.set(raw, identityLogin.test(key) ? person.login : person.name);
        } else if (identifier.test(key) && !replacements.has(raw)) {
          if (!ids.has(raw)) ids.set(raw, `local-id-${String(ids.size + 1).padStart(6, "0")}`);
          replacements.set(raw, ids.get(raw) ?? "");
        }
      }
    });
  const alternatives = [...replacements.keys()]
    .sort((a, b) => b.length - a.length)
    .map((key) =>
      /^\d+$/.test(key) ? `(?<!\\d)${escapePattern(key)}(?!\\d)` : escapePattern(key),
    );
  const foldedReplacements = new Map(
    [...replacements].map(([key, value]) => [key.toLowerCase(), value]),
  );
  const pattern = alternatives.length ? new RegExp(alternatives.join("|"), "giu") : undefined;
  const replace = (value: string) =>
    pattern
      ? value.replace(
          pattern,
          (match) =>
            replacements.get(match) ?? foldedReplacements.get(match.toLowerCase()) ?? match,
        )
      : value;
  function clean(value: unknown, key = ""): unknown {
    if (Array.isArray(value)) return value.map((child) => clean(child, key));
    if (object(value)) {
      const output: ObjectValue = {};
      for (const [name, child] of Object.entries(value)) {
        if (name === "parent_message_body" || name === "thread_message_body" || name === "owner_id")
          continue;
        output[name] = name === "color" ? "" : clean(child, name);
      }
      if (
        options.replaceText &&
        typeof output.type === "string" &&
        typeof output.text === "string"
      ) {
        if (output.type === "mention" && object(output.mention))
          output.text = `@${output.mention.user_login}`;
        else if (output.type === "emote") output.text = "Kappa";
        else if (output.type === "cheermote")
          output.text = `Cheer${object(output.cheermote) ? output.cheermote.bits : 1}`;
        else if (output.type === "gif") output.text = "[gif]";
      }
      if (options.replaceText && Array.isArray(output.fragments) && typeof output.text === "string")
        output.text = output.fragments
          .map((fragment) => (object(fragment) ? String(fragment.text ?? "") : ""))
          .join(" ");
      return output;
    }
    if (typeof value !== "string") return value;
    if (options.replaceText && prose.test(key)) return "Synthetic chat";
    // Preserve timestamps even when an unusually short numeric identity appears in a date.
    if (/(?:_at|timestamp)$/.test(key)) return value;
    if (/url$/.test(key)) return "https://example.invalid/local-fixture";
    const person = people.get(value);
    if (person && identityId.test(key)) return person.id;
    if (person && identityLogin.test(key)) return person.login;
    if (person && identityName.test(key)) return person.name;
    return replacements.get(value) ?? replace(value);
  }
  return `${records.map((value) => JSON.stringify(clean(value))).join("\n")}\n`;
}
