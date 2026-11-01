import { expect, test } from "vitest";
import { RecentChat } from "./recent-chat.js";

test("trailing chat counts distinct authors and removes expired, deleted and cleared messages", () => {
  const chat = new RecentChat();
  chat.observe({ id: "one", authorId: "a", authorName: "Alice", at: 0 });
  chat.observe({ id: "two", authorId: "a", authorName: "Alice", at: 1000 });
  chat.observe({ id: "three", authorId: "b", authorName: "Bob", at: 2000 });
  expect(chat.distinct(3000)).toBe(2);
  chat.removeMessage("one");
  expect(chat.distinct(3000)).toBe(2);
  chat.removeAuthor("b");
  expect(chat.distinct(3000)).toBe(1);
  expect(chat.distinct(61000)).toBe(0);
  chat.observe({ id: "four", authorId: "c", authorName: "Chris", at: 62000 });
  expect(chat.names(62000)).toEqual(["Chris"]);
  chat.clear();
  expect(chat.distinct(62000)).toBe(0);
});
