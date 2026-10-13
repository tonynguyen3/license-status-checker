export function getHoursNeeded(trade: string): number {
  switch (trade.trim()) {
    case "Plumber Trainee":
      return 8;
    case "Plumber":
      return 24;
    case "Electrician":
      return 24;
    default:
      return 0;
  }
}
