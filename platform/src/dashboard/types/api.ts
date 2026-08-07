export type AppAudience = "restricted" | "team" | "public";
export type AppRole = "viewer" | "editor" | "owner";
export type TeamRole = "member" | "admin";
export type MembershipStatus = "active" | "suspended";
export type ResourceStatus = "active" | "pending" | "unused" | "disabled" | "error";
export type ResourceKind = "runtime" | "database" | "storage" | "schedules" | "domain" | "email" | "secrets";

export interface BrowserUser {
  id: string;
  email: string | null;
  name: string | null;
  picture: string | null;
  platform_role: string;
}

export interface TeamSummary {
  id: string;
  slug: string;
  name: string;
  role: TeamRole;
}

export interface MeResponse {
  user: BrowserUser;
  teams: TeamSummary[];
  defaultTeamId: string | null;
  platformOwner: boolean;
}

export interface AppPermissions {
  role: AppRole | null;
  open: boolean;
  viewSettings: boolean;
  modifyMetadata: boolean;
  modifyRuntime: boolean;
  modifySecrets: boolean;
  modifyAccess: boolean;
  moveApp: boolean;
  destroy: boolean;
}

export interface ResourceNode {
  kind: ResourceKind;
  label: "App / runtime" | "Database" | "Storage" | "Schedules" | "Domain" | "Email" | "Secrets";
  status: ResourceStatus;
  detail: string;
  secondary?: string;
}

export interface ResourceTopology {
  nodes: ResourceNode[];
  summary: string[];
}

export interface ListedApp {
  id: string;
  slug: string;
  name: string;
  description: string;
  visibility: "private" | "team" | "public";
  audience: AppAudience;
  teamId: string;
  folderId: string | null;
  url: string;
  activeVersion: number | null;
  hasDatabase: boolean;
  hasFiles: boolean;
  databaseDeleteAfter: number | null;
  filesDeleteAfter: number | null;
  databaseAdopted: boolean;
  filesAdopted: boolean;
  managedBy: "manual" | "git";
  sourceHash: string | null;
  deploymentHash: string | null;
  createdAt: number;
  updatedAt: number;
  role: AppRole;
  permissions: AppPermissions;
  owner?: Pick<BrowserUser, "id" | "name" | "email"> | null;
  resources: ResourceTopology;
}

export interface AppsResponse {
  apps: ListedApp[];
}

export interface FolderSummary {
  id: string;
  slug: string;
  name: string;
  parentId: string | null;
  appCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface FoldersResponse {
  folders: FolderSummary[];
  rootAppCount: number;
  canAdmin: boolean;
}

export interface GroupSummary {
  id: string;
  slug: string;
  name: string;
  description: string;
  memberCount: number;
  appCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface GroupsResponse {
  groups: GroupSummary[];
  canAdmin: boolean;
}

export interface TeamMember {
  id: string;
  email: string | null;
  name: string | null;
  picture: string | null;
  role: TeamRole;
  status: MembershipStatus;
  created_at: number;
  updated_at: number;
}

export interface MembersResponse {
  members: TeamMember[];
  canAdmin: boolean;
}

export interface GroupMember {
  id: string;
  email: string | null;
  name: string | null;
  picture: string | null;
  created_at: number;
}

export interface GroupMembersResponse {
  group: Pick<GroupSummary, "id" | "slug" | "name">;
  members: GroupMember[];
  canAdmin: boolean;
}

export interface AccessSource {
  type: "platform" | "owner" | "user" | "group" | "team" | "public";
  role: AppRole;
  label: string;
  id?: string;
}

export interface AccessUser {
  id: string;
  email: string | null;
  name: string | null;
  picture: string | null;
  role: AppRole;
}

export interface AccessGroup {
  id: string;
  slug: string;
  name: string;
  description: string;
  role: "viewer" | "editor";
  member_count: number;
}

export interface AppAccess {
  audience: AppAudience;
  effectiveRole: AppRole | null;
  sources: AccessSource[];
  owner: Pick<BrowserUser, "id" | "email" | "name" | "picture"> | null;
  users: AccessUser[];
  groups: AccessGroup[];
  managedBy: "manual" | "git";
  readOnly: boolean;
}

export interface DeploymentSummary {
  id?: string;
  version: number;
  created_by?: string;
  created_at: number;
  status: string;
  has_worker?: boolean | number;
  created_by_name?: string | null;
  created_by_email?: string | null;
  manifest?: unknown;
}

export interface DomainSummary {
  hostname: string;
  status: ResourceStatus | string;
  error?: string | null;
  created_at: number;
  updated_at: number;
}

export interface ScheduleSummary {
  id: string;
  expression: string;
  next_run_at: number | null;
  last_run_at: number | null;
  last_status: string | null;
  last_error?: string | null;
}

export interface SecretSummary {
  name: string;
  updated_at?: number;
}

export interface ActivityEntry {
  id: string;
  action: string;
  detail: unknown;
  created_at: number;
  user_name: string | null;
  user_email: string | null;
}

export interface AppDetailResponse {
  app: ListedApp;
  access: AppAccess;
  deployments: DeploymentSummary[];
  secrets: SecretSummary[];
  domains: DomainSummary[];
  schedules: ScheduleSummary[];
  activity: ActivityEntry[];
  resources: ResourceTopology;
}

export interface ApiToken {
  id: string;
  name: string;
  prefix: string;
  app_id: string | null;
  created_at: number;
  last_used_at: number | null;
  expires_at: number | null;
}

export interface TokensResponse {
  tokens: ApiToken[];
}

export interface TokenCreationResponse {
  token: {
    id: string;
    name: string;
    prefix: string;
    secret: string;
    createdAt: number;
  };
}

export interface PruneResponse {
  ok: true;
  removed: string[];
}
