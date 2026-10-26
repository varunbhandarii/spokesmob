import type { Scenario, ScenarioLine } from "../../mock-eventsub/src/scenario.js";

export interface ClusterShare {
  name: string;
  share: number;
}

export interface CrowdOptions {
  authors?: number;
  rate?: number;
  seconds?: number;
  seed?: number;
  clusters?: readonly ClusterShare[];
  repeatShare?: number;
  typoShare?: number;
  caseShare?: number;
  emoteShare?: number;
}

type ChatLine = Extract<ScenarioLine, { kind: "chat" }>;

export const defaultClusters: readonly ClusterShare[] = Object.freeze([
  { name: "gary", share: 0.4 },
  { name: "pickles", share: 0.2 },
  { name: "noise", share: 0.4 },
]);

export function parseClusters(value: string): ClusterShare[] {
  const clusters = value.split(",").map((item) => {
    const [name, share, extra] = item.split(":");
    if (!name?.trim() || share === undefined || !share.trim() || extra !== undefined)
      throw new Error("Clusters must use name:share pairs");
    return { name: name.trim(), share: Number(share) };
  });
  validateClusters(clusters);
  return clusters;
}

function validateClusters(clusters: readonly ClusterShare[]): void {
  if (
    !clusters.length ||
    clusters.some(
      (cluster) => !cluster.name.trim() || !Number.isFinite(cluster.share) || cluster.share <= 0,
    ) ||
    new Set(clusters.map((cluster) => cluster.name)).size !== clusters.length ||
    Math.abs(clusters.reduce((sum, cluster) => sum + cluster.share, 0) - 1) > 0.000001
  )
    throw new Error("Cluster names must be unique and positive shares must sum to 1");
}

function randomSource(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    const item = result[index];
    const replacement = result[other];
    if (item !== undefined && replacement !== undefined) {
      result[index] = replacement;
      result[other] = item;
    }
  }
  return result;
}

function authorClusters(authors: number, clusters: readonly ClusterShare[]): string[] {
  const quotas = clusters.map((cluster) => ({
    name: cluster.name,
    count: Math.floor(authors * cluster.share),
    remainder: (authors * cluster.share) % 1,
  }));
  let remaining = authors - quotas.reduce((sum, cluster) => sum + cluster.count, 0);
  const ranked = [...quotas].sort((left, right) => right.remainder - left.remainder);
  for (const cluster of ranked) {
    if (remaining-- > 0) cluster.count += 1;
  }
  return quotas.flatMap((cluster) => Array.from({ length: cluster.count }, () => cluster.name));
}

function textFor(cluster: string, random: () => number): string {
  const alternatives =
    cluster === "noise"
      ? [
          "hello room",
          "what a cozy cat",
          "look at those paws",
          "cute little ears",
          "the cat is sleepy",
          "snack time",
        ]
      : [
          cluster,
          `name him ${cluster}`,
          `${cluster} please`,
          `${cluster} the cat`,
          `I vote ${cluster}`,
        ];
  return alternatives[Math.floor(random() * alternatives.length)] ?? cluster;
}

function typo(text: string, random: () => number): string {
  const letters = [...text.matchAll(/[a-z]/gi)].map((match) => match.index);
  if (!letters.length) return text;
  const index = letters[Math.floor(random() * letters.length)] ?? 0;
  return text.slice(0, index) + text[index] + text.slice(index);
}

export function generateScenario(options: CrowdOptions = {}): Scenario {
  const authors = options.authors ?? 300;
  const rate = options.rate ?? 60;
  const seconds = options.seconds ?? 60;
  const seed = options.seed ?? 1;
  const clusters = options.clusters ?? defaultClusters;
  const repeatShare = options.repeatShare ?? 0.15;
  const typoShare = options.typoShare ?? 0.12;
  const caseShare = options.caseShare ?? 0.2;
  const emoteShare = options.emoteShare ?? 0.05;
  if (
    !Number.isSafeInteger(authors) ||
    authors <= 0 ||
    !Number.isFinite(rate) ||
    rate <= 0 ||
    !Number.isFinite(seconds) ||
    seconds <= 0 ||
    !Number.isSafeInteger(seed)
  )
    throw new Error("Authors, rate, duration and seed must be valid positive values");
  if (rate > authors)
    throw new Error(
      "Rate exceeds one message per author per second; add authors or lower the rate",
    );
  if (
    [repeatShare, typoShare, caseShare, emoteShare].some(
      (value) => !Number.isFinite(value) || value < 0 || value > 1,
    )
  )
    throw new Error("Noise and repetition shares must be between 0 and 1");
  validateClusters(clusters);
  const random = randomSource(seed);
  const assignments = authorClusters(authors, clusters);
  const authorIds = Array.from({ length: authors }, (_, index) => index);
  const lastSent = new Map<number, number>();
  const previousMessages = new Map<number, Pick<ChatLine, "text" | "emotes">>();
  let queue: number[] = [];
  const lines: ScenarioLine[] = [];
  const count = Math.floor(rate * seconds);
  if (count < 1 || count > 1_000_000)
    throw new Error("Requested scenario must contain between one and one million messages");
  for (let index = 0; index < count; index += 1) {
    const t = Math.floor((index * 1000) / rate);
    if (!queue.length) queue = shuffled(authorIds, random);
    const candidate = queue.findIndex(
      (author) => t - (lastSent.get(author) ?? Number.NEGATIVE_INFINITY) >= 1000,
    );
    const author = queue.splice(candidate, 1)[0];
    if (candidate < 0 || author === undefined)
      throw new Error("Cannot satisfy per-author pacing at this rate");
    lastSent.set(author, t);
    const previous = previousMessages.get(author);
    let message: Pick<ChatLine, "text" | "emotes">;
    if (previous && random() < repeatShare) message = previous;
    else if (random() < emoteShare)
      message = { text: "Kappa", emotes: [{ name: "Kappa", id: "25" }] };
    else {
      let text = textFor(assignments[author] ?? "noise", random);
      if (random() < typoShare) text = typo(text, random);
      if (random() < caseShare)
        text = random() < 0.5 ? text.toUpperCase() : text.charAt(0).toUpperCase() + text.slice(1);
      message = { text };
    }
    previousMessages.set(author, message);
    const number = String(author + 1).padStart(Math.max(2, String(authors).length), "0");
    lines.push({ t, kind: "chat", user: `viewer${number}`, name: `Viewer ${number}`, ...message });
  }
  return {
    header: {
      scenario: "crowd-chat",
      channel: { id: "100000001", login: "spokesmob_demo" },
      speed: 1,
      seed,
    },
    lines,
  };
}

export function serializeScenario(scenario: Scenario): string {
  return `${[scenario.header, ...scenario.lines].map((line) => JSON.stringify(line)).join("\n")}\n`;
}
