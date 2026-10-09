import { MIN_COUNTED_SECONDS } from "../../app/util/rules";

export interface Game {
  queueId: number;
  gameMode: string;
  gameCreation: number;
  gameDuration: number;
  championId: number;
  win?: boolean;
  kills?: number;
  deaths?: number;
  assists?: number;
}

/** Games shorter than this are remakes or aborted games; the summary skips them. */

const QUEUE_NAMES: Record<number, string> = {
  400: "Normal Draft",
  420: "Ranked Solo/Duo",
  430: "Normal Blind",
  440: "Ranked Flex",
  450: "ARAM",
  490: "Quickplay",
  700: "Clash",
  1700: "Arena",
  2000: "Tutorial",
  3140: "Practice Tool",
};

export function queueName(g: Game): string {
  return QUEUE_NAMES[g.queueId] ?? g.gameMode;
}

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

interface Summary {
  counted: number;
  wins: number;
  /** Whole percent. */
  winRate: number;
  /** Most-played champion; a tie goes to the champion played most recently. */
  topChampionId: number;
  topChampionGames: number;
  avgDuration: number;
}

/** Summary of the counted games, or null when no game counts. */
export function summarize(games: Game[]): Summary | null {
  const counted = games.filter(
    (g) => g.gameDuration >= MIN_COUNTED_SECONDS && typeof g.win === "boolean"
  );
  if (!counted.length) return null;
  const wins = counted.filter((g) => g.win).length;

  const tally = new Map<number, { n: number; last: number }>();
  for (const g of counted) {
    const t = tally.get(g.championId) ?? { n: 0, last: 0 };
    tally.set(g.championId, { n: t.n + 1, last: Math.max(t.last, g.gameCreation) });
  }
  let [topId, top] = [...tally][0];
  for (const [id, t] of tally) {
    if (t.n > top.n || (t.n === top.n && t.last > top.last)) [topId, top] = [id, t];
  }

  return {
    counted: counted.length,
    wins,
    winRate: Math.round((wins / counted.length) * 100),
    topChampionId: topId,
    topChampionGames: top.n,
    avgDuration: counted.reduce((s, g) => s + g.gameDuration, 0) / counted.length,
  };
}
