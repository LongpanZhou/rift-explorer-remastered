import { expect, test } from "bun:test";
import { formatDuration, summarize, type Game } from "../../src/player/summary";

const g = (championId: number, win: boolean, gameDuration = 1800, gameCreation = 0): Game => ({
  queueId: 420,
  gameMode: "CLASSIC",
  gameCreation,
  gameDuration,
  championId,
  win,
});

test("remakes are excluded and the win rate rounds to a whole percent", () => {
  const s = summarize([g(1, true), g(1, false), g(2, true), g(3, false, 120)]);
  expect(s.counted).toBe(3);
  expect(s.winRate).toBe(67);
});

test("a most-played tie goes to the champion played most recently", () => {
  const s = summarize([g(1, true, 1800, 10), g(2, true, 1800, 20), g(1, false, 1800, 5), g(2, false, 1800, 30)]);
  expect(s.topChampionId).toBe(2);
  expect(s.topChampionGames).toBe(2);
});

test("no counted games gives no summary, not zeros", () => {
  expect(summarize([g(1, true, 60)])).toBeNull();
});

test("durations format as m:ss", () => {
  expect(formatDuration(1517)).toBe("25:17");
  expect(formatDuration(8)).toBe("0:08");
});
