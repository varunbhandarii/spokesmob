export interface RecentChatter {
  id: string;
  authorId: string;
  authorName: string;
  authorLogin?: string;
  at: number;
}
export class RecentChat {
  private readonly messages = new Map<string, RecentChatter>();
  observe(message: RecentChatter) {
    this.messages.set(message.id, message);
    this.prune(message.at);
  }
  private prune(at: number) {
    for (const [id, message] of this.messages)
      if (message.at <= at - 60000) this.messages.delete(id);
  }
  distinct(at: number) {
    this.prune(at);
    return new Set([...this.messages.values()].map((message) => message.authorId)).size;
  }
  names(at: number) {
    this.prune(at);
    return [
      ...new Set(
        [...this.messages.values()].flatMap((message) => [
          message.authorName,
          ...(message.authorLogin ? [message.authorLogin] : []),
        ]),
      ),
    ];
  }
  removeMessage(id: string) {
    this.messages.delete(id);
  }
  removeAuthor(id: string) {
    for (const [key, message] of this.messages)
      if (message.authorId === id) this.messages.delete(key);
  }
  clear() {
    this.messages.clear();
  }
}
