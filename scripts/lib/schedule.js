// Shared "is this the real 8pm Mountain tick" gate - used by every workflow that runs on the
// twice-daily cron pattern (one tick for MST, one for MDT; GitHub Actions cron is fixed UTC and
// doesn't observe daylight saving, so both ticks fire every day and this function tells the
// caller which one, if either, is actually 8pm Mountain right now).
export function isManualRun() {
  return process.env.GITHUB_EVENT_NAME === 'workflow_dispatch';
}

export function isEightPmMountain() {
  const hourStr = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Denver',
    hour: 'numeric',
    hour12: false,
  }).format(new Date());
  return Number(hourStr) === 20;
}
