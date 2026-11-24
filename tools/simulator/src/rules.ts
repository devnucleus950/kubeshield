// EVERY Falco rule name, tag and field name the simulator uses lives in this one
// file. Rule names are modelled on Falco's default rules, but must be checked
// against the real rule files in Phase 6; when they differ, edit them HERE only.

export const FIELDS = {
  namespace: 'k8s.ns.name',
  pod: 'k8s.pod.name',
  containerId: 'container.id',
  containerName: 'container.name',
  containerPrivileged: 'container.privileged',
  image: 'container.image.repository',
  procName: 'proc.name',
  procCmdline: 'proc.cmdline',
  procPid: 'proc.pid',
  procPpid: 'proc.ppid',
  procPname: 'proc.pname',
  user: 'user.name',
  fdName: 'fd.name',
  clientIp: 'fd.cip',
  clientPort: 'fd.cport',
  serverIp: 'fd.sip',
  serverPort: 'fd.sport',
} as const;

export type Priority = 'Emergency' | 'Alert' | 'Critical' | 'Error' | 'Warning' | 'Notice' | 'Informational' | 'Debug';

export interface RuleDef {
  rule: string;
  priority: Priority;
  tags: string[];
  message: string; // the human sentence at the start of Falco's `output`
}

export const RULES = {
  // shell-attack: four steps, priorities rising Notice -> Warning -> Error -> Critical
  shell: {
    rule: 'Terminal shell in container',
    priority: 'Notice',
    tags: ['container', 'shell', 'mitre_execution'],
    message: 'A shell was spawned in a container with an attached terminal',
  },
  networkTool: {
    rule: 'Launch Suspicious Network Tool in Container',
    priority: 'Warning',
    tags: ['network', 'process', 'mitre_execution'],
    message: 'Network tool launched in container',
  },
  sensitiveRead: {
    rule: 'Read sensitive file untrusted',
    priority: 'Error',
    tags: ['filesystem', 'mitre_credential_access'],
    message: 'Sensitive file opened for reading by non-trusted program',
  },
  outbound: {
    rule: 'Unexpected outbound connection destination',
    priority: 'Critical',
    tags: ['network', 'mitre_command_and_control'],
    message: 'Outbound connection to an unexpected destination',
  },

  privileged: {
    rule: 'Launch Privileged Container',
    priority: 'Warning',
    tags: ['container', 'cis', 'workload', 'mitre_privilege_escalation'],
    message: 'Privileged container started',
  },

  // file-tamper
  writeEtc: {
    rule: 'Write below etc',
    priority: 'Error',
    tags: ['filesystem', 'mitre_persistence'],
    message: 'File below /etc opened for writing',
  },
  writeBin: {
    rule: 'Write below binary dir',
    priority: 'Error',
    tags: ['filesystem', 'mitre_persistence'],
    message: 'File below a known binary directory opened for writing',
  },
  cron: {
    rule: 'Schedule Cron Jobs',
    priority: 'Notice',
    tags: ['file', 'mitre_persistence'],
    message: 'Cron jobs were scheduled to run',
  },

  // baseline noise: low priority, no attack tags
  packageManager: {
    rule: 'Launch Package Management Process in Container',
    priority: 'Informational',
    tags: ['container', 'process'],
    message: 'Package management process launched in container',
  },
  configRead: {
    rule: 'Read Configuration File',
    priority: 'Debug',
    tags: ['filesystem'],
    message: 'Configuration file read',
  },
  dns: {
    rule: 'DNS Lookup',
    priority: 'Debug',
    tags: ['network'],
    message: 'Name resolution performed',
  },
} satisfies Record<string, RuleDef>;

export const TARGET_CONTAINER_RUNTIME = 'runc:[2:INIT]';
