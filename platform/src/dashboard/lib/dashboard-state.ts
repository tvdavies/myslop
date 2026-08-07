import type { TeamSummary } from "@/types/api";

export function selectActiveTeamId(
  teams: TeamSummary[],
  requestedTeamId: string | null,
  defaultTeamId: string | null,
): string | null {
  if (requestedTeamId && teams.some((team) => team.id === requestedTeamId)) return requestedTeamId;
  if (defaultTeamId && teams.some((team) => team.id === defaultTeamId)) return defaultTeamId;
  return teams[0]?.id ?? null;
}

export function shouldFocusMainRoute(
  previousPathname: string,
  pathname: string,
  focusIsWithinMain: boolean,
): boolean {
  return previousPathname !== pathname && !focusIsWithinMain;
}
