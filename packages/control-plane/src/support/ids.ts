export function shortId(id: string, length = 8): string {
  return id.slice(0, length);
}

export function assignmentHandle(id: string): string {
  return `hs-assignment-${id}`;
}
