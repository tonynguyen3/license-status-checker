export function formattedDate(date = new Date()): string {
  return `${date.getMonth() + 1}-${date.getDate()}-${date.getFullYear()}`;
}

export function daysUntil(expirationDate: Date, today = new Date()): number {
  const oneDayMs = 24 * 60 * 60 * 1000;
  return Math.floor((expirationDate.getTime() - today.getTime()) / oneDayMs);
}
