// "Sep 2020": how a date reads in a history copy's progress (how far back it
// has got, and how far back it goes), on a Doco's status card and its
// integration pages alike. UTC, so the server and the browser agree.

export function monthYear(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}
