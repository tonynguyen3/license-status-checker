export function formattedDate(date = new Date()): string {
  return `${date.getMonth() + 1}-${date.getDate()}-${date.getFullYear()}`;
}

export function daysUntil(expirationDate: Date, today = new Date()): number {
  const oneDayMs = 24 * 60 * 60 * 1000;
  const expirationUtc = Date.UTC(
    expirationDate.getFullYear(),
    expirationDate.getMonth(),
    expirationDate.getDate()
  );
  const todayUtc = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.floor((expirationUtc - todayUtc) / oneDayMs);
}
