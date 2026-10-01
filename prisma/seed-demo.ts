/**
 * Demo data: a realistic PayGo operation in Ghana, about eleven months in. Four branches (Accra,
 * Kumasi, Tamale, Takoradi), staff in every role, around 170 riders with KYC, guarantors and
 * next of kin, bikes with trackers, loans with full schedules, and each loan's payment history
 * simulated day by day from a rider persona (reliable, irregular, struggling, defaulting, or
 * paying off early). Warnings, locks and unlocks, rider SMS, staff alerts, repossessions,
 * resales, and a few hours of GPS telemetry follow from that history.
 *
 * It uses the application's own pure rules (schedule generation, oldest-first allocation, the
 * overdue rule, message wording), and every ledger transaction balances, so the running app
 * sees consistent data: the sweep keeps locked bikes locked and does not suddenly act.
 *
 *   npm run db:seed:demo
 *
 * Development only: refuses to run with NODE_ENV=production, and refuses to run twice (demo
 * staff use @demo.paygo.test addresses). For a clean demo, reset first:
 *   npm run db:reset && npm run db:seed && npm run db:seed:demo
 *
 * Deterministic: the same seed produces the same people and histories, relative to today.
 */
import 'dotenv/config';
import * as argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { type Prisma, PrismaClient } from '../src/generated/prisma/client';
import {
  AssignmentEndReason,
  BikeStatus,
  ContactType,
  CustomerStatus,
  DesiredStateSource,
  EnforcementEventType,
  LedgerAccount,
  LedgerTransactionType,
  LoanFrequency,
  LoanStatus,
  MobilityState,
  NotificationKind,
  NotificationStatus,
  PaymentStatus,
  StaffAlertKind,
  StaffAuditEventType,
  StaffRole,
} from '../src/generated/prisma/enums';
import {
  addDays,
  allocatePayment,
  generateSchedule,
  overdueMinor,
  utcDay,
  type ScheduledInstallment,
} from '../src/loans/schedule';
import {
  immobilizedText,
  lockoutWarningText,
  reminderText,
  restoredText,
} from '../src/notifications/messages';

// ---------------------------------------------------------------------------
// Determinism and time
// ---------------------------------------------------------------------------

let state = 20260930;
/** mulberry32: small, fast, and the same sequence on every machine. */
function random(): number {
  state = (state + 0x6d2b79f5) | 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const int = (min: number, max: number): number =>
  min + Math.floor(random() * (max - min + 1));
const pick = <T>(items: readonly T[]): T => items[int(0, items.length - 1)];
const chance = (p: number): boolean => random() < p;
const digits = (n: number): string =>
  Array.from({ length: n }, () => int(0, 9)).join('');

const NOW = new Date();
const TODAY = utcDay(NOW);
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const daysAgo = (n: number): Date => addDays(TODAY, -n);
/** A moment on `day` at hh:mm plus up to `spreadMin` minutes, never in the future. */
function at(day: Date, hh: number, mm = 0, spreadMin = 0): Date {
  const time = new Date(
    utcDay(day).getTime() + (hh * 60 + mm + int(0, spreadMin)) * 60_000,
  );
  return time > NOW ? new Date(NOW.getTime() - int(1, 30) * 60_000) : time;
}
const seconds = (date: Date, s: number): Date =>
  new Date(date.getTime() + s * 1000);
/** Like at(), but may lie in the future: for deciding whether a moment has happened yet. */
const moment = (day: Date, hh: number, mm = 0, spreadMin = 0): Date =>
  new Date(utcDay(day).getTime() + (hh * 60 + mm + int(0, spreadMin)) * 60_000);
const isoDay = (date: Date): string => date.toISOString().slice(0, 10);

const DEMO_DOMAIN = 'demo.paygo.test';
const WARNING_LEAD_HOURS = 12;

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

interface Branch {
  code: string;
  city: string;
  region: string;
  plate: string;
  lat: number;
  lng: number;
  districts: string[];
  riders: number;
  names: 'south' | 'north' | 'west';
}

const BRANCHES: Branch[] = [
  {
    code: 'ACC',
    city: 'Accra',
    region: 'Greater Accra',
    plate: 'GR',
    lat: 5.6037,
    lng: -0.187,
    districts: [
      'Madina',
      'Kasoa',
      'Ashaiman',
      'Teshie',
      'Dansoman',
      'Adenta',
      'Kaneshie',
      'Nima',
      'Lapaz',
      'Amasaman',
    ],
    riders: 55,
    names: 'south',
  },
  {
    code: 'KSI',
    city: 'Kumasi',
    region: 'Ashanti',
    plate: 'AS',
    lat: 6.6885,
    lng: -1.6244,
    districts: [
      'Suame',
      'Kwadaso',
      'Asafo',
      'Bantama',
      'Tafo',
      'Ejisu',
      'Santasi',
      'Atonsu',
    ],
    riders: 45,
    names: 'south',
  },
  {
    code: 'TML',
    city: 'Tamale',
    region: 'Northern',
    plate: 'NR',
    lat: 9.4034,
    lng: -0.8424,
    districts: [
      'Sagnarigu',
      'Kalpohin',
      'Lamashegu',
      'Changli',
      'Vittin',
      'Kukuo',
      'Gumani',
    ],
    riders: 45,
    names: 'north',
  },
  {
    code: 'TKD',
    city: 'Takoradi',
    region: 'Western',
    plate: 'WR',
    lat: 4.896,
    lng: -1.755,
    districts: [
      'Effiakuma',
      'Kwesimintsim',
      'Anaji',
      'Sekondi',
      'Apremdo',
      'Tanokrom',
    ],
    riders: 25,
    names: 'west',
  },
];

const FIRST_NAMES = {
  south: [
    'Kwame',
    'Kofi',
    'Kwabena',
    'Kwaku',
    'Yaw',
    'Kojo',
    'Kwasi',
    'Emmanuel',
    'Samuel',
    'Daniel',
    'Isaac',
    'Richard',
    'Francis',
    'Prince',
    'Ebenezer',
    'Michael',
    'Joseph',
    'Stephen',
    'Eric',
    'Frank',
    'Bright',
    'Godfred',
    'Nana',
    'Kelvin',
    'Collins',
    'Evans',
    'Solomon',
    'Felix',
  ],
  north: [
    'Alhassan',
    'Fuseini',
    'Abdulai',
    'Iddrisu',
    'Sulemana',
    'Yakubu',
    'Tahiru',
    'Salifu',
    'Mohammed',
    'Abdul-Rashid',
    'Mustapha',
    'Issah',
    'Ibrahim',
    'Abubakari',
    'Wumbei',
    'Sumaila',
    'Rashid',
    'Hamza',
    'Nuhu',
    'Baba',
  ],
  west: [
    'Kwesi',
    'Kojo',
    'Ekow',
    'Kweku',
    'Kobina',
    'Fiifi',
    'Paa',
    'Emmanuel',
    'Ebo',
    'Samuel',
    'Isaac',
    'Nii',
    'Prince',
    'Joseph',
    'Albert',
    'Moses',
  ],
};
const WOMEN = {
  south: [
    'Ama',
    'Akosua',
    'Adwoa',
    'Abena',
    'Akua',
    'Yaa',
    'Afua',
    'Esi',
    'Gifty',
    'Mercy',
    'Comfort',
    'Patience',
  ],
  north: [
    'Fatima',
    'Amina',
    'Mariam',
    'Rahinatu',
    'Hawa',
    'Zenabu',
    'Ayishetu',
    'Sana',
  ],
  west: ['Esi', 'Efua', 'Araba', 'Ekua', 'Aba', 'Adjoa', 'Grace', 'Joyce'],
};
const SURNAMES = {
  south: [
    'Mensah',
    'Asante',
    'Owusu',
    'Boateng',
    'Osei',
    'Appiah',
    'Agyemang',
    'Addo',
    'Amoah',
    'Darko',
    'Ofori',
    'Adjei',
    'Quaye',
    'Tetteh',
    'Lamptey',
    'Ankrah',
    'Nkansah',
    'Frimpong',
    'Gyamfi',
    'Acheampong',
    'Sarpong',
    'Yeboah',
    'Opoku',
    'Danso',
    'Antwi',
    'Kyei',
    'Asamoah',
    'Bonsu',
    'Amponsah',
    'Tawiah',
  ],
  north: [
    'Alhassan',
    'Abdulai',
    'Mahama',
    'Iddrisu',
    'Seidu',
    'Issahaku',
    'Fuseini',
    'Mohammed',
    'Yakubu',
    'Salifu',
    'Abubakari',
    'Wumbei',
    'Zakaria',
    'Mumuni',
    'Adam',
    'Karim',
  ],
  west: [
    'Eshun',
    'Arthur',
    'Quansah',
    'Mensah',
    'Ackah',
    'Essien',
    'Kwofie',
    'Cudjoe',
    'Bentil',
    'Ansah',
    'Blankson',
    'Aidoo',
    'Baidoo',
    'Hagan',
  ],
};
/** Relationship, and whether that person is a man, a woman, or either. */
const GUARANTOR_RELATIONS: Array<[string, 'man' | 'woman' | 'either']> = [
  ['Brother', 'man'],
  ['Uncle', 'man'],
  ['Cousin', 'either'],
  ['Father', 'man'],
  ['Mother', 'woman'],
  ['Aunt', 'woman'],
  ['Friend', 'either'],
  ['Landlord', 'either'],
  ['Church elder', 'man'],
  ['Station chairman', 'man'],
  ['Former employer', 'either'],
];
const KIN_RELATIONS: Array<[string, 'man' | 'woman']> = [
  ['Wife', 'woman'],
  ['Mother', 'woman'],
  ['Sister', 'woman'],
  ['Brother', 'man'],
  ['Father', 'man'],
];
function personNamed(
  sex: 'man' | 'woman' | 'either',
  pool: 'south' | 'north' | 'west',
): string {
  const asWoman = sex === 'woman' || (sex === 'either' && chance(0.35));
  return pick(asWoman ? WOMEN[pool] : FIRST_NAMES[pool]);
}

/** Relatives share the rider's surname only where that relationship usually would. */
const SHARES_SURNAME = new Set(['Brother', 'Father', 'Sister', 'Uncle']);
const STREETS = [
  'Mango Street',
  'Palm Avenue',
  'Zongo Lane',
  'Liberation Road',
  'Church Road',
  'Market Street',
  'Kotoko Road',
  'Station Road',
  'School Junction',
  'Water Works Road',
];
const LANDMARKS = [
  'near the Methodist church',
  'behind the police station',
  'opposite the Total filling station',
  'near the lorry station',
  'close to the central mosque',
  'behind the JHS block',
  'near the chop bar junction',
  'opposite the MTN mast',
];
const PHONE_PREFIXES = [
  '24',
  '54',
  '55',
  '59',
  '53',
  '20',
  '50',
  '26',
  '27',
  '56',
  '57',
];

interface Model {
  make: string;
  model: string;
  vinPrefix: string;
  cashPrice: number; // GHS
  supplier: string;
  share: number;
}
const MODELS: Model[] = [
  {
    make: 'Bajaj',
    model: 'Boxer BM150',
    vinPrefix: 'MD2A11CZ',
    cashPrice: 22500,
    supplier: 'Kantamanto Motors Ltd',
    share: 0.42,
  },
  {
    make: 'Haojue',
    model: 'HJ125-8',
    vinPrefix: 'LC6PCJ2B',
    cashPrice: 16000,
    supplier: 'Northern Moto Supplies',
    share: 0.2,
  },
  {
    make: 'TVS',
    model: 'HLX 125',
    vinPrefix: 'MD626DG1',
    cashPrice: 17800,
    supplier: 'Kantamanto Motors Ltd',
    share: 0.18,
  },
  {
    make: 'Honda',
    model: 'Ace CB125',
    vinPrefix: 'ME4JC651',
    cashPrice: 19500,
    supplier: 'Suame Auto Traders',
    share: 0.12,
  },
  {
    make: 'Apsonic',
    model: 'AP150-30',
    vinPrefix: 'LAPPCK0H',
    cashPrice: 14500,
    supplier: 'Northern Moto Supplies',
    share: 0.08,
  },
];
const COLORS = ['Red', 'Black', 'Blue', 'Red', 'Black', 'Silver', 'Maroon'];

type Persona =
  'reliable' | 'irregular' | 'struggling' | 'defaulter' | 'finisher';

// ---------------------------------------------------------------------------
// Uniqueness against whatever is already in the database
// ---------------------------------------------------------------------------

const taken = {
  phones: new Set<string>(),
  nationalIds: new Set<string>(),
  vins: new Set<string>(),
  plates: new Set<string>(),
  imeis: new Set<string>(),
  labels: new Set<string>(),
  emails: new Set<string>(),
};
function unique(set: Set<string>, make: () => string): string {
  for (let i = 0; i < 1000; i += 1) {
    const value = make();
    if (!set.has(value)) {
      set.add(value);
      return value;
    }
  }
  throw new Error('Could not generate a unique value');
}
const phone = (): string =>
  unique(taken.phones, () => `+233${pick(PHONE_PREFIXES)}${digits(7)}`);
const ghanaCard = (): string =>
  unique(taken.nationalIds, () => `GHA-${digits(9)}-${digits(1)}`);
const VIN_CHARS = 'ABCDEFGHJKLMNPRSTUVWXYZ0123456789';
const vin = (prefix: string): string =>
  unique(
    taken.vins,
    () =>
      prefix +
      Array.from({ length: 17 - prefix.length }, () =>
        pick([...VIN_CHARS]),
      ).join(''),
  );
const plate = (branch: Branch, year: number): string =>
  unique(
    taken.plates,
    () => `M-${String(year).slice(2)}-${branch.plate} ${int(1000, 9999)}`,
  );
const imei = (): string => unique(taken.imeis, () => `3520940${digits(8)}`);

// ---------------------------------------------------------------------------
// Row buffers, flushed at the end in dependency order
// ---------------------------------------------------------------------------

const rows = {
  users: [] as Prisma.UserCreateManyInput[],
  staffAudit: [] as Prisma.StaffAuditEventCreateManyInput[],
  customers: [] as Prisma.CustomerCreateManyInput[],
  contacts: [] as Prisma.CustomerContactCreateManyInput[],
  bikes: [] as Prisma.BikeCreateManyInput[],
  trackers: [] as Prisma.BikeTrackerInstallationCreateManyInput[],
  assignments: [] as Prisma.BikeAssignmentCreateManyInput[],
  statusChanges: [] as Prisma.BikeStatusChangeCreateManyInput[],
  loans: [] as Prisma.LoanCreateManyInput[],
  installments: [] as Prisma.LoanInstallmentCreateManyInput[],
  payments: [] as Prisma.PaymentCreateManyInput[],
  allocations: [] as Prisma.PaymentAllocationCreateManyInput[],
  ledgerTransactions: [] as Prisma.LedgerTransactionCreateManyInput[],
  ledgerEntries: [] as Prisma.LedgerEntryCreateManyInput[],
  enforcement: [] as Prisma.BikeEnforcementCreateManyInput[],
  enforcementEvents: [] as Prisma.EnforcementEventCreateManyInput[],
  notifications: [] as Prisma.NotificationCreateManyInput[],
  alerts: [] as Prisma.StaffAlertCreateManyInput[],
  positions: [] as Prisma.BikePositionCreateManyInput[],
  current: [] as Prisma.BikeCurrentPositionCreateManyInput[],
};

function ledger(
  type: LedgerTransactionType,
  description: string,
  currency: string,
  createdAt: Date,
  links: { loanId?: string; paymentId?: string },
  lines: Array<{
    account: LedgerAccount;
    loanId?: string;
    debit?: number;
    credit?: number;
  }>,
): void {
  const used = lines.filter(
    (line) => (line.debit ?? 0) + (line.credit ?? 0) > 0,
  );
  const debits = used.reduce((sum, line) => sum + (line.debit ?? 0), 0);
  const credits = used.reduce((sum, line) => sum + (line.credit ?? 0), 0);
  if (debits !== credits) {
    throw new Error(`Unbalanced demo ledger posting: ${description}`);
  }
  const id = randomUUID();
  rows.ledgerTransactions.push({
    id,
    type,
    description,
    createdAt,
    loanId: links.loanId,
    paymentId: links.paymentId,
  });
  for (const line of used) {
    rows.ledgerEntries.push({
      transactionId: id,
      account: line.account,
      loanId: line.loanId,
      debitMinor: line.debit ?? 0,
      creditMinor: line.credit ?? 0,
      currency,
      createdAt,
    });
  }
}

// ---------------------------------------------------------------------------
// Staff
// ---------------------------------------------------------------------------

interface Staff {
  id: string;
  firstName: string;
  lastName: string;
  role: StaffRole;
  branch: string;
  joined: Date;
  active: boolean;
  left: Date | null;
}

function buildStaff(passwordHash: string, founderId: string | null): Staff[] {
  const people: Array<
    Omit<Staff, 'id' | 'active' | 'left'> & {
      leftDaysAgo?: number;
      leaveReason?: string;
    }
  > = [
    {
      firstName: 'Abena',
      lastName: 'Owusu-Ansah',
      role: StaffRole.ADMIN,
      branch: 'Accra',
      joined: daysAgo(345),
    },
    {
      firstName: 'Kwaku',
      lastName: 'Frimpong',
      role: StaffRole.ADMIN,
      branch: 'Kumasi',
      joined: daysAgo(330),
    },
    {
      firstName: 'Esi',
      lastName: 'Arthur',
      role: StaffRole.FINANCE,
      branch: 'Accra',
      joined: daysAgo(340),
    },
    {
      firstName: 'Yaw',
      lastName: 'Darko',
      role: StaffRole.FINANCE,
      branch: 'Kumasi',
      joined: daysAgo(300),
    },
    {
      firstName: 'Fatima',
      lastName: 'Alhassan',
      role: StaffRole.FINANCE,
      branch: 'Tamale',
      joined: daysAgo(260),
    },
    {
      firstName: 'Emmanuel',
      lastName: 'Tetteh',
      role: StaffRole.FIELD_AGENT,
      branch: 'Accra',
      joined: daysAgo(338),
    },
    {
      firstName: 'Samuel',
      lastName: 'Quaye',
      role: StaffRole.FIELD_AGENT,
      branch: 'Accra',
      joined: daysAgo(310),
    },
    {
      firstName: 'Prince',
      lastName: 'Ankrah',
      role: StaffRole.FIELD_AGENT,
      branch: 'Accra',
      joined: daysAgo(336),
      leftDaysAgo: 110,
      leaveReason: 'Resigned to start his own spare parts shop in Kasoa',
    },
    {
      firstName: 'Kofi',
      lastName: 'Acheampong',
      role: StaffRole.FIELD_AGENT,
      branch: 'Kumasi',
      joined: daysAgo(325),
    },
    {
      firstName: 'Isaac',
      lastName: 'Sarpong',
      role: StaffRole.FIELD_AGENT,
      branch: 'Kumasi',
      joined: daysAgo(280),
    },
    {
      firstName: 'Iddrisu',
      lastName: 'Mahama',
      role: StaffRole.FIELD_AGENT,
      branch: 'Tamale',
      joined: daysAgo(262),
    },
    {
      firstName: 'Abdul-Rashid',
      lastName: 'Seidu',
      role: StaffRole.FIELD_AGENT,
      branch: 'Tamale',
      joined: daysAgo(250),
    },
    {
      firstName: 'Kwesi',
      lastName: 'Eshun',
      role: StaffRole.FIELD_AGENT,
      branch: 'Takoradi',
      joined: daysAgo(240),
    },
    {
      firstName: 'Ebenezer',
      lastName: 'Kwofie',
      role: StaffRole.FIELD_AGENT,
      branch: 'Takoradi',
      joined: daysAgo(150),
    },
  ];

  const staff: Staff[] = [];
  let head: Staff | null = null;
  for (const person of people) {
    const id = randomUUID();
    const email = unique(
      taken.emails,
      () =>
        `${person.firstName}.${person.lastName}`
          .toLowerCase()
          .replace(/[^a-z.]/g, '') + `@${DEMO_DOMAIN}`,
    );
    const left =
      person.leftDaysAgo !== undefined
        ? at(daysAgo(person.leftDaysAgo), 16, 30, 60)
        : null;
    const branchAdmin = staff.find(
      (s) => s.role === StaffRole.ADMIN && s.branch === person.branch,
    );
    rows.users.push({
      id,
      email,
      passwordHash,
      firstName: person.firstName,
      lastName: person.lastName,
      phone: phone(),
      role: person.role,
      branch: person.branch,
      isActive: !left,
      deactivatedAt: left,
      deactivationReason: left ? person.leaveReason : null,
      supervisorId:
        person.role === StaffRole.ADMIN
          ? null
          : ((branchAdmin ?? head)?.id ?? null),
      lastLoginAt: left
        ? addDays(left, -1)
        : at(daysAgo(int(0, 2)), int(7, 18), 0, 59),
      passwordChangedAt: at(person.joined, 9, 30, 90),
      createdAt: at(person.joined, 8, 15, 60),
      updatedAt: left ?? at(person.joined, 9, 30, 90),
    });
    const record: Staff = { id, ...person, active: !left, left };
    staff.push(record);
    head ??= record;

    const creator = person === people[0] ? (founderId ?? id) : head.id;
    rows.staffAudit.push({
      type: StaffAuditEventType.ACCOUNT_CREATED,
      actorUserId: creator,
      targetUserId: id,
      detail: { email, role: person.role },
      createdAt: at(person.joined, 8, 15, 60),
    });
    rows.staffAudit.push({
      type: StaffAuditEventType.PASSWORD_CHANGED,
      actorUserId: id,
      targetUserId: id,
      createdAt: at(person.joined, 9, 30, 90),
    });
    if (left) {
      rows.staffAudit.push({
        type: StaffAuditEventType.DEACTIVATED,
        actorUserId: head.id,
        targetUserId: id,
        detail: { reason: person.leaveReason ?? '' },
        createdAt: left,
      });
    }
  }
  return staff;
}

// ---------------------------------------------------------------------------
// Riders, bikes, loans
// ---------------------------------------------------------------------------

interface Rider {
  id: string;
  firstName: string;
  lastName: string;
  phone: string;
  branch: Branch;
  home: { lat: number; lng: number };
  registered: Date;
}

function makeRider(
  branch: Branch,
  registeredBy: Staff,
  assignedAgent: Staff,
  verifier: Staff,
  registered: Date,
  status: CustomerStatus,
): Rider {
  const woman = chance(0.06);
  const pool = branch.names;
  const firstName = pick(woman ? WOMEN[pool] : FIRST_NAMES[pool]);
  const lastName = pick(SURNAMES[pool]);
  const id = randomUUID();
  const district = pick(branch.districts);
  const verified = status !== CustomerStatus.PENDING_KYC;
  const riderPhone = phone();
  const dob = new Date(Date.UTC(int(1978, 2004), int(0, 11), int(1, 28)));
  rows.customers.push({
    id,
    status,
    phone: riderPhone,
    alternatePhone: chance(0.3) ? phone() : null,
    phoneVerifiedAt: verified ? at(registered, 11, 0, 240) : null,
    firstName,
    lastName,
    nationalId: ghanaCard(),
    photoUrl: `https://files.${DEMO_DOMAIN}/kyc/${id}/photo.jpg`,
    idDocumentUrl: `https://files.${DEMO_DOMAIN}/kyc/${id}/ghana-card.jpg`,
    dateOfBirth: dob,
    kycVerifiedAt: verified
      ? at(addDays(registered, int(0, 2)), 14, 0, 180)
      : null,
    kycVerifiedById: verified ? verifier.id : null,
    addressLine: chance(0.6)
      ? `H/No. ${int(1, 99)}, ${pick(STREETS)}`
      : `${district}, ${pick(LANDMARKS)}`,
    ward: `${district} ${pick(['North', 'South', 'East', 'West', 'Central'])}`,
    district,
    region: branch.region,
    registeredById: registeredBy.id,
    assignedAgentId: assignedAgent.id,
    createdAt: at(registered, 10, 0, 300),
    updatedAt: at(registered, 10, 0, 300),
  });
  const guarantor = pick(GUARANTOR_RELATIONS);
  // A woman rider's spouse is her husband; a man's is his wife.
  const kin: [string, 'man' | 'woman'] = (() => {
    const drawn = pick(KIN_RELATIONS);
    return woman && drawn[0] === 'Wife' ? ['Husband', 'man'] : drawn;
  })();
  rows.contacts.push({
    type: ContactType.GUARANTOR,
    firstName: personNamed(guarantor[1], pool),
    lastName: SHARES_SURNAME.has(guarantor[0])
      ? lastName
      : pick(SURNAMES[pool]),
    phone: phone(),
    relationship: guarantor[0],
    nationalId: chance(0.7) ? ghanaCard() : null,
    addressLine: `${pick(branch.districts)}, ${pick(LANDMARKS)}`,
    customerId: id,
    createdAt: at(registered, 10, 30, 300),
    updatedAt: at(registered, 10, 30, 300),
  });
  rows.contacts.push({
    type: ContactType.NEXT_OF_KIN,
    firstName: personNamed(kin[1], pool),
    lastName: SHARES_SURNAME.has(kin[0]) ? lastName : pick(SURNAMES[pool]),
    phone: phone(),
    relationship: kin[0],
    nationalId: null,
    addressLine: null,
    customerId: id,
    createdAt: at(registered, 10, 30, 300),
    updatedAt: at(registered, 10, 30, 300),
  });
  const spread = 0.045;
  return {
    id,
    firstName,
    lastName,
    phone: riderPhone,
    branch,
    home: {
      lat: branch.lat + (random() - 0.5) * spread * 2,
      lng: branch.lng + (random() - 0.5) * spread * 2,
    },
    registered,
  };
}

interface Bike {
  id: string;
  model: Model;
  branch: Branch;
  label: string;
  name: string;
  imei: string | null;
}

const labelCounters = new Map<string, number>();
function makeBike(
  branch: Branch,
  purchased: Date,
  admin: Staff,
  status: BikeStatus = BikeStatus.IN_INVENTORY,
): Bike {
  const roll = random();
  let cumulative = 0;
  const model =
    MODELS.find((m) => (cumulative += m.share) >= roll) ?? MODELS[0];
  const id = randomUUID();
  const next = (labelCounters.get(branch.code) ?? 0) + 1;
  labelCounters.set(branch.code, next);
  const label = unique(
    taken.labels,
    () => `${branch.code}-${String(next).padStart(3, '0')}`,
  );
  const reg = plate(branch, purchased.getUTCFullYear());
  const priceMinor =
    Math.round(model.cashPrice * (0.72 + random() * 0.06)) * 100;
  rows.bikes.push({
    id,
    label,
    vin: vin(model.vinPrefix),
    registrationNumber: reg,
    make: model.make,
    model: model.model,
    year: purchased.getUTCFullYear() - (chance(0.2) ? 1 : 0),
    color: pick(COLORS),
    purchasePriceMinor: priceMinor,
    purchaseCurrency: 'GHS',
    purchasedAt: utcDay(purchased),
    supplier: model.supplier,
    status,
    createdAt: at(purchased, 9, 0, 120),
    updatedAt: at(purchased, 9, 0, 120),
  });
  rows.statusChanges.push({
    bikeId: id,
    fromStatus: null,
    toStatus: BikeStatus.IN_INVENTORY,
    reason: 'Added to inventory',
    actorUserId: admin.id,
    createdAt: at(purchased, 9, 0, 120),
  });
  return { id, model, branch, label, name: reg, imei: null };
}

function fitTracker(bike: Bike, when: Date, agent: Staff): void {
  bike.imei = imei();
  // The bike row carries the fitted IMEI: it is what tracking and enforcement resolve.
  rows.bikes.find((b) => b.id === bike.id)!.imei = bike.imei;
  rows.trackers.push({
    bikeId: bike.id,
    imei: bike.imei,
    installedAt: when,
    installedById: agent.id,
  });
}

function setBikeStatus(
  bike: Bike,
  from: BikeStatus,
  to: BikeStatus,
  reason: string,
  actor: Staff,
  when: Date,
): void {
  rows.statusChanges.push({
    bikeId: bike.id,
    fromStatus: from,
    toStatus: to,
    reason,
    actorUserId: actor.id,
    createdAt: when,
  });
  const row = rows.bikes.find((b) => b.id === bike.id)!;
  row.status = to;
  row.updatedAt = when;
  if (to === BikeStatus.RETIRED) {
    row.retiredAt = when;
  }
}

// ---------------------------------------------------------------------------
// Payment simulation
// ---------------------------------------------------------------------------

interface SimPayment {
  id: string;
  paidAt: Date;
  /** When the money counted against the loan: paidAt, or when staff allocated it. */
  effectiveAt: Date;
  amountMinor: number;
  manual: boolean;
  allocatedLater: Date | null;
}

interface LoanTerms {
  principalMinor: number;
  installmentMinor: number;
  frequency: LoanFrequency;
  graceDays: number;
  start: Date;
  firstDue: Date;
}

function paymentTimeOn(day: Date): Date {
  // Most riders pay in the evening after work; some first thing in the morning.
  return chance(0.7) ? at(day, 17, 30, 240) : at(day, 6, 30, 150);
}

function simulatePayments(
  terms: LoanTerms,
  schedule: ScheduledInstallment[],
  persona: Persona,
  stopDay: Date | null,
  until: Date,
): SimPayment[] {
  const payments: SimPayment[] = [];
  let paid = 0;
  const unit = terms.frequency === LoanFrequency.DAILY ? 500 : 1000; // round to GHS 5 / GHS 10
  const roundUp = (minor: number) => Math.ceil(minor / unit) * unit;
  let gapUntil: Date | null = null;
  // When a struggling rider's trouble began: drawn once, not once per day.
  const strugglingFrom = daysAgo(int(35, 70));

  for (let day = utcDay(terms.start); day <= until; day = addDays(day, 1)) {
    if (paid >= terms.principalMinor) {
      break;
    }
    if (stopDay && day >= stopDay) {
      break;
    }
    const dueSoFar = schedule
      .filter((i) => i.dueDate <= day)
      .reduce((s, i) => s + i.amountMinor, 0);
    const behind = dueSoFar - paid;
    const remaining = terms.principalMinor - paid;
    let amount = 0;

    const inGap = gapUntil !== null && day < gapUntil;
    if (!inGap) {
      gapUntil = null;
    }

    switch (persona) {
      case 'reliable':
        if (
          behind > 0 &&
          chance(terms.frequency === LoanFrequency.DAILY ? 0.95 : 0.96)
        ) {
          // Daily riders often pay two or three days at once.
          amount =
            behind + (chance(0.3) ? terms.installmentMinor * int(1, 2) : 0);
        }
        break;
      case 'finisher':
        if (chance(terms.frequency === LoanFrequency.DAILY ? 0.7 : 0.5)) {
          amount = Math.max(behind, 0) + terms.installmentMinor * int(1, 3);
        }
        break;
      case 'irregular':
        if (!inGap && chance(0.011)) {
          gapUntil = addDays(day, int(3, 7)); // sick, bike in the fitting shop, travelled home
        } else if (!inGap && behind > 0 && chance(0.72)) {
          amount = chance(0.3)
            ? roundUp(behind * (0.4 + random() * 0.5))
            : behind;
        }
        break;
      case 'struggling': {
        const late = day >= strugglingFrom;
        if (behind > 0 && chance(late ? 0.22 : 0.5)) {
          amount = roundUp(
            behind * (late ? 0.3 + random() * 0.4 : 0.6 + random() * 0.4),
          );
        }
        break;
      }
      case 'defaulter':
        if (behind > 0 && chance(0.5)) {
          amount = roundUp(behind * (0.5 + random() * 0.5));
        }
        break;
    }

    if (amount <= 0) {
      continue;
    }
    // A last payment is sometimes a round figure a little over what is owed.
    amount =
      amount >= remaining
        ? remaining + (chance(0.3) ? int(1, 9) * 50 : 0)
        : Math.max(amount, 100);
    const paidAt = paymentTimeOn(day);
    if (paidAt > NOW) {
      continue;
    }
    const allocatedLater = chance(0.012)
      ? new Date(paidAt.getTime() + int(2, 20) * HOUR_MS)
      : null;
    const effectiveAt =
      allocatedLater && allocatedLater < NOW ? allocatedLater : paidAt;
    payments.push({
      id: randomUUID(),
      paidAt,
      effectiveAt,
      amountMinor: amount,
      manual: chance(0.08),
      allocatedLater:
        allocatedLater && allocatedLater < NOW ? allocatedLater : null,
    });
    paid += Math.min(amount, remaining);
  }
  return payments.sort(
    (a, b) => a.effectiveAt.getTime() - b.effectiveAt.getTime(),
  );
}

// ---------------------------------------------------------------------------
// Loan history: schedule, payments, ledger, notifications, enforcement
// ---------------------------------------------------------------------------

interface LoanStory {
  rider: Rider;
  bike: Bike;
  agent: Staff;
  admin: Staff;
  finance: Staff;
  persona: Persona;
  start: Date;
  frequency: LoanFrequency;
  /** For defaulters: the day they stopped paying. */
  stopDay: Date | null;
  /** Repossessed this many days after stopping; null to leave the loan DEFAULTED. */
  repossessAfter: number | null;
  /** Tracker went dark this many days after stopping (a rider hiding the bike). */
  darkAfter: number | null;
  /** The agent who registered the rider and fitted the tracker. */
  installer: Staff;
  assignmentId?: string;
}

interface LoanOutcome {
  loanId: string;
  status: LoanStatus;
  completedAt: Date | null;
  closedAt: Date | null;
  locked: boolean;
  lockedSince: Date | null;
  overdueNow: number;
  dark: boolean;
}

let referenceCounter = 400000;
const manualCounters = new Map<string, number>();

function writeLoan(story: LoanStory): LoanOutcome {
  const { rider, bike, persona, frequency } = story;
  const cash = Math.round(bike.model.cashPrice * (0.96 + random() * 0.08));
  const deposit = Math.round((cash * (0.1 + random() * 0.06)) / 50) * 50;
  const principal =
    Math.round(
      ((cash - deposit) *
        (persona === 'finisher' ? 1.22 : 1.28 + random() * 0.07)) /
        100,
    ) * 100;
  const daily = frequency === LoanFrequency.DAILY;
  const periods =
    persona === 'finisher'
      ? daily
        ? int(260, 300)
        : int(38, 44)
      : daily
        ? int(380, 470)
        : int(55, 68);
  const installment =
    Math.ceil(principal / periods / (daily ? 5 : 10)) * (daily ? 5 : 10);
  const graceDays = daily ? int(1, 2) : int(2, 3);
  const firstDue = addDays(story.start, daily ? 1 : 7);
  const principalMinor = principal * 100;
  const installmentMinor = installment * 100;

  const schedule = generateSchedule({
    principalMinor,
    installmentMinor,
    frequency,
    firstDueDate: firstDue,
  });
  const loanId = randomUUID();
  const createdAt = at(story.start, 10, 0, 240);
  const installmentIds: string[] = schedule.map(() => randomUUID());
  const paidPerInstallment = schedule.map(() => 0);
  const paidAtPerInstallment: Array<Date | null> = schedule.map(() => null);

  ledger(
    LedgerTransactionType.LOAN_ORIGINATION,
    'Loan started',
    'GHS',
    createdAt,
    { loanId },
    [
      { account: LedgerAccount.LOAN_RECEIVABLE, loanId, debit: principalMinor },
      { account: LedgerAccount.FINANCED_ASSETS, credit: principalMinor },
    ],
  );

  const payments = simulatePayments(
    {
      principalMinor,
      installmentMinor,
      frequency,
      graceDays,
      start: story.start,
      firstDue,
    },
    schedule,
    persona,
    story.stopDay,
    TODAY,
  );

  // --- apply payments in the order they counted, exactly as LoanRepaymentService would ---
  let paidTotal = 0;
  let completedAt: Date | null = null;
  const paidTimeline: Array<{ at: Date; total: number; paymentId: string }> =
    [];
  for (const payment of payments) {
    if (completedAt) {
      break;
    }
    const balances = schedule.map((row, index) => ({
      id: installmentIds[index],
      sequence: row.sequence,
      amountMinor: row.amountMinor,
      paidMinor: paidPerInstallment[index],
    }));
    const { allocations, leftoverMinor } = allocatePayment(
      balances,
      payment.amountMinor,
    );
    const applied = payment.amountMinor - leftoverMinor;

    for (const allocation of allocations) {
      const index = installmentIds.indexOf(allocation.installmentId);
      paidPerInstallment[index] += allocation.amountMinor;
      if (paidPerInstallment[index] === schedule[index].amountMinor) {
        paidAtPerInstallment[index] = payment.effectiveAt;
      }
      rows.allocations.push({
        paymentId: payment.id,
        installmentId: allocation.installmentId,
        amountMinor: allocation.amountMinor,
        createdAt: payment.effectiveAt,
      });
    }

    const branchCode = rider.branch.code;
    let reference: string;
    if (payment.manual) {
      const n = (manualCounters.get(branchCode) ?? 0) + 1;
      manualCounters.set(branchCode, n);
      reference = `CASH-${branchCode}-${isoDay(payment.paidAt).replace(/-/g, '')}-${String(n).padStart(4, '0')}`;
    } else {
      referenceCounter += int(1, 40);
      reference = `PG-${loanId.slice(0, 8).toUpperCase()}-${referenceCounter}`;
    }
    const payerPhone = payment.manual
      ? null
      : chance(0.88)
        ? rider.phone
        : phone();
    rows.payments.push({
      id: payment.id,
      provider: payment.manual ? 'manual' : 'paystack',
      providerReference: reference,
      providerTransactionId: payment.manual
        ? null
        : String(4_100_000_000 + int(0, 899_999_999)),
      channel: payment.manual ? 'cash' : 'mobile_money',
      payerPhone,
      amountMinor: payment.amountMinor,
      currency: 'GHS',
      paidAt: payment.paidAt,
      receivedAt: seconds(payment.paidAt, int(2, 25)),
      status: PaymentStatus.APPLIED,
      statusReason: null,
      loanId,
      overpaidMinor: leftoverMinor,
      recordedById: payment.manual ? story.finance.id : null,
      allocatedById: payment.allocatedLater ? story.finance.id : null,
      allocatedAt: payment.allocatedLater,
    });

    if (payment.allocatedLater) {
      // Arrived without the loan reference: held, then allocated by finance.
      ledger(
        LedgerTransactionType.PAYMENT_RECEIVED,
        `paystack payment ${reference} held unallocated`,
        'GHS',
        payment.paidAt,
        { paymentId: payment.id },
        [
          {
            account: LedgerAccount.PROVIDER_CLEARING,
            debit: payment.amountMinor,
          },
          {
            account: LedgerAccount.UNALLOCATED_FUNDS,
            credit: payment.amountMinor,
          },
        ],
      );
      ledger(
        LedgerTransactionType.PAYMENT_ALLOCATED,
        `Allocated payment ${reference}`,
        'GHS',
        payment.allocatedLater,
        { loanId, paymentId: payment.id },
        [
          {
            account: LedgerAccount.UNALLOCATED_FUNDS,
            debit: payment.amountMinor,
          },
          { account: LedgerAccount.LOAN_RECEIVABLE, loanId, credit: applied },
          { account: LedgerAccount.RIDER_CREDIT, credit: leftoverMinor },
        ],
      );
    } else {
      ledger(
        LedgerTransactionType.PAYMENT_RECEIVED,
        `${payment.manual ? 'manual' : 'paystack'} payment ${reference}`,
        'GHS',
        payment.paidAt,
        { loanId, paymentId: payment.id },
        [
          {
            account: LedgerAccount.PROVIDER_CLEARING,
            debit: payment.amountMinor,
          },
          { account: LedgerAccount.LOAN_RECEIVABLE, loanId, credit: applied },
          { account: LedgerAccount.RIDER_CREDIT, credit: leftoverMinor },
        ],
      );
    }

    paidTotal += applied;
    paidTimeline.push({
      at: payment.effectiveAt,
      total: paidTotal,
      paymentId: payment.id,
    });
    if (paidTotal === principalMinor) {
      completedAt = payment.effectiveAt;
    }
  }

  const paidBy = (moment: Date): number => {
    let total = 0;
    for (const point of paidTimeline) {
      if (point.at <= moment) {
        total = point.total;
      }
    }
    return total;
  };
  const oldestUnpaidAt = (moment: Date): number => {
    let remaining = paidBy(moment);
    for (let i = 0; i < schedule.length; i += 1) {
      remaining -= schedule[i].amountMinor;
      if (remaining < 0) {
        return i;
      }
    }
    return -1;
  };
  const dueUpTo = (day: Date): number =>
    schedule
      .filter((i) => i.dueDate <= day)
      .reduce((s, i) => s + i.amountMinor, 0);

  // --- status, repossession ---
  let status: LoanStatus = completedAt
    ? LoanStatus.COMPLETED
    : LoanStatus.ACTIVE;
  let closedAt: Date | null = null;
  let defaultedAt: Date | null = null;
  if (story.stopDay && !completedAt) {
    defaultedAt = at(addDays(story.stopDay, int(25, 32)), 11, 0, 240);
    if (defaultedAt < NOW) {
      status = LoanStatus.DEFAULTED;
    }
    if (story.repossessAfter !== null) {
      const repossessed = at(
        addDays(story.stopDay, story.repossessAfter),
        9,
        0,
        300,
      );
      if (repossessed < NOW) {
        status = LoanStatus.REPOSSESSED;
        closedAt = repossessed;
      }
    }
  }
  const endOfStory = closedAt ?? NOW;

  // --- warnings, locks and unlocks, day by day ---
  const darkFrom =
    story.stopDay && story.darkAfter !== null
      ? at(addDays(story.stopDay, story.darkAfter), 21, 0, 120)
      : null;
  let locked = false;
  let lockedSince: Date | null = null;
  const warned = new Map<number, Date>();
  let lastConfirmed: MobilityState | null = null;
  let enforcementRow = false;
  // Within one arrears episode: the desired-state change and a deferral are each written once.
  let desiredWritten = false;
  let deferredWritten = false;

  const riderContext = { firstName: rider.firstName, bikeName: bike.name };
  const sms = (
    kind: NotificationKind,
    key: string,
    body: string,
    sentAt: Date,
    installmentIndex?: number,
  ): string => {
    const id = randomUUID();
    const failed = chance(0.008);
    const pending =
      !failed && (sentAt > new Date(NOW.getTime() - 60_000) || chance(0.05));
    const messageStatus = failed
      ? NotificationStatus.FAILED
      : pending
        ? NotificationStatus.SENT
        : NotificationStatus.DELIVERED;
    rows.notifications.push({
      id,
      kind,
      dedupeKey: key,
      status: messageStatus,
      customerId: rider.id,
      loanId,
      installmentId:
        installmentIndex !== undefined
          ? installmentIds[installmentIndex]
          : null,
      bikeId: bike.id,
      channel: 'arkesel-sms',
      recipient: rider.phone,
      body,
      providerMessageId: randomUUID(),
      attempts: 1,
      lastError: failed
        ? 'Provider reported the message undelivered (UNDELIVERED)'
        : null,
      createdAt: sentAt,
      sentAt,
      deliveredAt: failed || pending ? null : seconds(sentAt, int(3, 45)),
      failedAt: failed ? seconds(sentAt, int(60, 900)) : null,
    });
    if (failed) {
      rows.alerts.push({
        kind: StaffAlertKind.NOTIFICATION_FAILED,
        dedupeKey: `notification-failed:${id}`,
        title:
          kind === NotificationKind.LOCKOUT_WARNING
            ? 'A pre-lockout warning could not be delivered'
            : 'A rider message could not be delivered',
        detail:
          kind === NotificationKind.LOCKOUT_WARNING
            ? 'Provider reported the message undelivered (UNDELIVERED). The rider may not know their bike can be immobilized. Contact them another way.'
            : 'Provider reported the message undelivered (UNDELIVERED). Check the phone number on the rider record.',
        bikeId: bike.id,
        customerId: rider.id,
        notificationId: id,
        createdAt: seconds(sentAt, int(60, 900)),
        acknowledgedAt:
          sentAt < daysAgo(3) ? seconds(sentAt, int(2, 30) * 3600) : null,
        acknowledgedById: sentAt < daysAgo(3) ? story.finance.id : null,
      });
    }
    return id;
  };
  const event = (
    data: Omit<Prisma.EnforcementEventCreateManyInput, 'bikeId'>,
  ): string => {
    const id = randomUUID();
    rows.enforcementEvents.push({ id, bikeId: bike.id, ...data });
    enforcementRow = true;
    return id;
  };
  const telemetry = (moment: Date) => ({
    speed: 0,
    ignition: false,
    movement: false,
    hasFix: true,
    online: true,
    recordedAt: seconds(moment, -int(20, 90)).toISOString(),
    lastReportedAt: seconds(moment, -int(5, 40)).toISOString(),
  });

  for (
    let day = utcDay(firstDue);
    day <= utcDay(endOfStory);
    day = addDays(day, 1)
  ) {
    // 08:00 run: warn about the oldest unpaid installment that has fallen due.
    const morning = moment(day, 8, 0, 25);
    if (morning <= endOfStory && morning <= NOW) {
      const index = oldestUnpaidAt(morning);
      if (index >= 0 && !warned.has(index)) {
        const row = schedule[index];
        if (addDays(row.dueDate, Math.min(graceDays, 1)) <= day) {
          const lastGrace = addDays(row.dueDate, graceDays);
          const owing = dueUpTo(day) - paidBy(morning);
          if (owing > 0) {
            warned.set(index, morning);
            sms(
              NotificationKind.LOCKOUT_WARNING,
              `lockout-warning:${installmentIds[index]}`,
              lockoutWarningText(
                riderContext,
                owing,
                'GHS',
                lastGrace < day ? day : lastGrace,
              ),
              morning,
              index,
            );
          }
        }
      }
    }

    // Payments during the day may clear arrears and restore a locked bike.
    if (locked) {
      for (const point of paidTimeline) {
        if (
          utcDay(point.at).getTime() !== day.getTime() ||
          point.at > endOfStory
        ) {
          continue;
        }
        const current =
          overdueMinor(schedule, point.total, graceDays, point.at) === 0;
        if (current && locked) {
          locked = false;
          lockedSince = null;
          const desired = seconds(point.at, int(3, 20));
          event({
            type: EnforcementEventType.DESIRED_STATE_CHANGED,
            trigger: 'arrears',
            fromState: MobilityState.IMMOBILIZED,
            toState: MobilityState.MOBILE,
            reason: 'Payment brought the loan current',
            detail: { loanId, paymentId: point.paymentId },
            createdAt: desired,
          });
          event({
            type: EnforcementEventType.COMMAND_SENT,
            trigger: 'arrears',
            fromState: MobilityState.IMMOBILIZED,
            toState: MobilityState.MOBILE,
            reason: 'Desired state differs from confirmed state',
            detail: { command: 'setdigout 0' },
            createdAt: seconds(desired, 1),
          });
          const confirmedId = event({
            type: EnforcementEventType.STATE_CONFIRMED,
            trigger: 'command-response',
            fromState: MobilityState.IMMOBILIZED,
            toState: MobilityState.MOBILE,
            reason: 'Device reported its output state',
            deviceResponse: 'Setdigout 0 OK',
            createdAt: seconds(desired, int(4, 30)),
          });
          lastConfirmed = MobilityState.MOBILE;
          sms(
            NotificationKind.BIKE_RESTORED,
            `restored:${confirmedId}`,
            restoredText(riderContext, true),
            seconds(desired, int(35, 60)),
          );
        }
      }
    }

    // Evening sweep: lock a warned, overdue bike once it is parked for the night.
    const evening = moment(day, 20, 30, 120);
    if (!locked && evening <= endOfStory && evening <= NOW) {
      const paid = paidBy(evening);
      const overdue = overdueMinor(schedule, paid, graceDays, evening);
      const index = oldestUnpaidAt(evening);
      const warning = warned.get(index);
      const lockable =
        overdue > 0 &&
        warning !== undefined &&
        evening.getTime() - warning.getTime() >= WARNING_LEAD_HOURS * HOUR_MS;
      if (lockable) {
        const dark = darkFrom !== null && evening >= darkFrom;
        const desiredAt = evening;
        if (!desiredWritten) {
          event({
            type: EnforcementEventType.DESIRED_STATE_CHANGED,
            trigger: 'arrears',
            fromState: MobilityState.MOBILE,
            toState: MobilityState.IMMOBILIZED,
            reason: 'Overdue past grace period',
            detail: {
              loanId,
              overdueMinor: overdue,
              currency: 'GHS',
              asOf: isoDay(day),
              warned: true,
            },
            createdAt: desiredAt,
          });
          desiredWritten = true;
        }
        if (dark) {
          // The tracker has gone quiet: nothing is sent, and a person is asked to look.
          if (!deferredWritten) {
            event({
              type: EnforcementEventType.COMMAND_DEFERRED,
              trigger: 'sweep',
              fromState: lastConfirmed,
              toState: MobilityState.IMMOBILIZED,
              reason: 'interlock:offline',
              createdAt: seconds(desiredAt, 2),
            });
            const reviewId = event({
              type: EnforcementEventType.REVIEW_FLAGGED,
              trigger: 'sweep',
              fromState: lastConfirmed,
              toState: MobilityState.IMMOBILIZED,
              reason:
                'Immobilize wanted but telemetry cannot be trusted: interlock:offline',
              createdAt: seconds(desiredAt, 2),
            });
            rows.alerts.push({
              kind: StaffAlertKind.ENFORCEMENT_REVIEW,
              dedupeKey: `enforcement-review:${reviewId}`,
              title: `Bike ${bike.name} should be immobilized, but its position cannot be trusted`,
              detail:
                'Enforcement deferred the lock (interlock:offline): the tracker is offline or its last reading is too old to prove the bike is stopped. Nothing will be sent until it reports again. Check on the bike and the rider.',
              bikeId: bike.id,
              customerId: rider.id,
              createdAt: seconds(desiredAt, 3),
            });
            deferredWritten = true;
          }
          continue;
        }
        const sent = seconds(desiredAt, int(30, 600));
        event({
          type: EnforcementEventType.COMMAND_SENT,
          trigger: 'sweep',
          fromState: lastConfirmed,
          toState: MobilityState.IMMOBILIZED,
          reason: 'Desired state differs from confirmed state',
          telemetry: telemetry(sent),
          detail: { command: 'setdigout 1' },
          createdAt: sent,
        });
        const confirmedId = event({
          type: EnforcementEventType.STATE_CONFIRMED,
          trigger: 'command-response',
          fromState: lastConfirmed,
          toState: MobilityState.IMMOBILIZED,
          reason: 'Device reported its output state',
          deviceResponse: 'Setdigout 1 OK',
          createdAt: seconds(sent, int(3, 25)),
        });
        lastConfirmed = MobilityState.IMMOBILIZED;
        desiredWritten = false;
        deferredWritten = false;
        locked = true;
        lockedSince = seconds(sent, 25);
        sms(
          NotificationKind.BIKE_IMMOBILIZED,
          `immobilized:${confirmedId}`,
          immobilizedText(riderContext, {
            kind: 'arrears',
            overdueMinor: overdue,
            currency: 'GHS',
          }),
          seconds(sent, int(30, 60)),
        );
      }
    }
  }

  // Reminders for the last ten days, the day before each due date, 07:00 to 07:30.
  if (status === LoanStatus.ACTIVE || status === LoanStatus.DEFAULTED) {
    schedule.forEach((row, index) => {
      const sendDay = addDays(row.dueDate, -1);
      if (sendDay < daysAgo(10) || sendDay > TODAY) {
        return;
      }
      const sendAt = at(sendDay, 7, 0, 30);
      if (
        sendAt > NOW ||
        paidPerInstallmentAt(index, sendAt) >= row.amountMinor
      ) {
        return;
      }
      sms(
        NotificationKind.PAYMENT_REMINDER,
        `reminder:${installmentIds[index]}`,
        reminderText(
          riderContext,
          row.amountMinor - paidPerInstallmentAt(index, sendAt),
          'GHS',
          row.dueDate,
        ),
        sendAt,
        index,
      );
    });
  }
  function paidPerInstallmentAt(index: number, moment: Date): number {
    let remaining = paidBy(moment);
    for (let i = 0; i < index; i += 1) {
      remaining -= schedule[i].amountMinor;
    }
    return Math.max(0, Math.min(schedule[index].amountMinor, remaining));
  }

  // --- the loan and its installments ---
  rows.loans.push({
    id: loanId,
    customerId: rider.id,
    bikeId: bike.id,
    assignmentId: story.assignmentId!,
    status,
    currency: 'GHS',
    principalMinor,
    downPaymentMinor: deposit * 100,
    installmentMinor,
    frequency,
    graceDays,
    firstDueDate: schedule[0].dueDate,
    endDate: schedule[schedule.length - 1].dueDate,
    installmentCount: schedule.length,
    createdById: story.admin.id,
    createdAt,
    completedAt,
    closedAt,
    closedById:
      status === LoanStatus.DEFAULTED || status === LoanStatus.REPOSSESSED
        ? story.admin.id
        : null,
    closedReason:
      status === LoanStatus.REPOSSESSED
        ? pick([
            'Bike recovered after 6 weeks without payment',
            'Rider unreachable, bike recovered from his house',
            'Repossessed with the station chairman present',
          ])
        : status === LoanStatus.DEFAULTED
          ? pick([
              'No payment in over a month, rider not answering calls',
              'Guarantor says rider has travelled',
              'Rider refuses to pay, says the bike is faulty',
            ])
          : null,
    updatedAt:
      closedAt ??
      completedAt ??
      (status === LoanStatus.DEFAULTED && defaultedAt
        ? defaultedAt
        : createdAt),
  });
  schedule.forEach((row, index) => {
    rows.installments.push({
      id: installmentIds[index],
      loanId,
      sequence: row.sequence,
      dueDate: row.dueDate,
      amountMinor: row.amountMinor,
      paidMinor: paidPerInstallment[index],
      paidAt: paidAtPerInstallment[index],
    });
  });

  const dark =
    darkFrom !== null && darkFrom < NOW && status !== LoanStatus.REPOSSESSED;
  if (enforcementRow) {
    const overdueNow = overdueMinor(schedule, paidTotal, graceDays, NOW);
    const deferred = deferredWritten && !locked;
    rows.enforcement.push({
      bikeId: bike.id,
      desiredState:
        locked || deferred ? MobilityState.IMMOBILIZED : MobilityState.MOBILE,
      desiredSource: DesiredStateSource.ARREARS,
      confirmedState: lastConfirmed,
      confirmedAt: lastConfirmed ? (lockedSince ?? endOfStory) : null,
      pendingCommand: null,
      pendingSentAt: null,
      blockedReason: deferred ? 'interlock:offline' : null,
      reviewReason: deferred ? 'interlock:offline' : null,
      reviewSince: deferred ? darkFrom : null,
    });
    return {
      loanId,
      status,
      completedAt,
      closedAt,
      locked,
      lockedSince,
      overdueNow,
      dark,
    };
  }
  return {
    loanId,
    status,
    completedAt,
    closedAt,
    locked,
    lockedSince,
    overdueNow: overdueMinor(schedule, paidTotal, graceDays, NOW),
    dark,
  };
}

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

function telemetryFor(
  bike: Bike,
  home: { lat: number; lng: number },
  mode: 'riding' | 'parked' | 'dark',
  darkSince?: Date,
): void {
  if (!bike.imei) {
    return;
  }
  const points: Prisma.BikePositionCreateManyInput[] = [];
  const minutes = mode === 'dark' ? 60 : 150;
  const end = mode === 'dark' ? (darkSince ?? daysAgo(3)) : NOW;
  let lat = home.lat;
  let lng = home.lng;
  let heading = int(0, 359);
  let moving = false;
  // Pack voltage (48 V lithium, 42.0 V empty to 54.6 V full) sags as the bike is ridden, and the
  // tracker odometer has months of daily work on it already.
  let voltageMv = int(46500, 54200);
  let odometerM = int(2500, 31000) * 1000;
  for (let m = minutes; m >= 0; m -= 1) {
    const recordedAt = new Date(end.getTime() - m * 60_000 - int(0, 20) * 1000);
    const hour = recordedAt.getUTCHours();
    const dayTime = hour >= 6 && hour < 21;
    if (mode === 'riding' && dayTime) {
      if (chance(moving ? 0.12 : 0.18)) {
        moving = !moving;
      }
    } else {
      moving = false;
    }
    let speed = 0;
    if (moving) {
      speed = int(12, 55);
      heading = (heading + int(-35, 35) + 360) % 360;
      const km = speed / 60;
      odometerM += Math.round(km * 1000);
      voltageMv = Math.max(43200, voltageMv - int(15, 45));
      lat += (km / 111) * Math.cos((heading * Math.PI) / 180);
      lng += (km / 111) * Math.sin((heading * Math.PI) / 180);
    }
    points.push({
      bikeId: bike.id,
      recordedAt,
      receivedAt: seconds(recordedAt, int(1, 6)),
      latitude: Number(lat.toFixed(6)),
      longitude: Number(lng.toFixed(6)),
      altitude: int(20, bike.branch.code === 'KSI' ? 290 : 190),
      angle: heading,
      satellites: int(7, 14),
      speed,
      ignition: moving || (mode === 'riding' && chance(0.1)),
      movement: moving,
      hasFix: true,
      externalVoltageMv: voltageMv + int(-60, 60),
      odometerMeters: odometerM,
    });
  }
  rows.positions.push(...points);
  const last = points[points.length - 1];
  rows.current.push({
    bikeId: bike.id,
    recordedAt: last.recordedAt,
    receivedAt: last.receivedAt,
    latitude: last.latitude,
    longitude: last.longitude,
    altitude: last.altitude,
    angle: last.angle,
    satellites: last.satellites,
    speed: last.speed,
    ignition: last.ignition,
    movement: last.movement,
    hasFix: true,
    externalVoltageMv: last.externalVoltageMv,
    odometerMeters: last.odometerMeters,
  });
  const bikeRow = rows.bikes.find((b) => b.id === bike.id)!;
  bikeRow.lastReportedAt = last.receivedAt;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

type Assigned = LoanStory;

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('The demo seed never runs with NODE_ENV=production');
  }
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required');
  }
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
  });

  try {
    const existing = await prisma.user.count({
      where: { email: { endsWith: `@${DEMO_DOMAIN}` } },
    });
    if (existing > 0) {
      console.log(
        `Demo data is already present (${existing} demo staff). Reset first for a fresh copy:`,
      );
      console.log(
        '  npm run db:reset && npm run db:seed && npm run db:seed:demo',
      );
      return;
    }

    const [users, customers, bikes] = await Promise.all([
      prisma.user.findMany({ select: { email: true, phone: true } }),
      prisma.customer.findMany({ select: { phone: true, nationalId: true } }),
      prisma.bike.findMany({
        select: {
          vin: true,
          registrationNumber: true,
          imei: true,
          label: true,
        },
      }),
    ]);
    users.forEach((u) => {
      taken.emails.add(u.email);
      if (u.phone) taken.phones.add(u.phone);
    });
    customers.forEach((c) => {
      taken.phones.add(c.phone);
      taken.nationalIds.add(c.nationalId);
    });
    bikes.forEach((b) => {
      taken.vins.add(b.vin);
      if (b.registrationNumber) taken.plates.add(b.registrationNumber);
      if (b.imei) taken.imeis.add(b.imei);
      taken.labels.add(b.label);
    });

    const founder = await prisma.user.findFirst({
      where: {
        role: StaffRole.ADMIN,
        isActive: true,
        email: { not: { endsWith: `@${DEMO_DOMAIN}` } },
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    const password = process.env.DEMO_STAFF_PASSWORD ?? 'PayGoDemo!2026';
    if (password.length < 12) {
      throw new Error('DEMO_STAFF_PASSWORD must be at least 12 characters');
    }
    const passwordHash = await argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    });
    const staff = buildStaff(passwordHash, founder?.id ?? null);

    const byBranch = (branch: Branch, role: StaffRole, activeOnly = true) =>
      staff.filter(
        (s) =>
          s.branch === branch.city &&
          s.role === role &&
          (!activeOnly || s.active),
      );
    const adminFor = (branch: Branch) =>
      staff.find(
        (s) =>
          s.role === StaffRole.ADMIN &&
          s.branch ===
            (branch.city === 'Kumasi' || branch.city === 'Tamale'
              ? 'Kumasi'
              : 'Accra'),
      )!;
    const financeFor = (branch: Branch) =>
      staff.find(
        (s) =>
          s.role === StaffRole.FINANCE &&
          s.branch === (branch.city === 'Takoradi' ? 'Accra' : branch.city),
      )!;

    const personas: Persona[] = [];
    const counts: Record<Persona, number> = {
      reliable: 80,
      irregular: 38,
      struggling: 18,
      defaulter: 11,
      finisher: 12,
    };
    for (const [persona, count] of Object.entries(counts) as Array<
      [Persona, number]
    >) {
      for (let i = 0; i < count; i += 1) personas.push(persona);
    }
    personas.sort(() => random() - 0.5);

    const stories: Assigned[] = [];
    const riderOf = new Map<string, Rider>();
    let personaIndex = 0;
    let defaulterCount = 0;

    for (const branch of BRANCHES) {
      const agents = staff.filter(
        (s) => s.branch === branch.city && s.role === StaffRole.FIELD_AGENT,
      );
      const active = agents.filter((a) => a.active);
      const admin = adminFor(branch);
      const finance = financeFor(branch);

      // The branch opened when its first agent joined; nothing there is older than that.
      const opened = Math.floor(
        (TODAY.getTime() - Math.min(...agents.map((a) => a.joined.getTime()))) /
          DAY_MS,
      );

      for (let r = 0; r < branch.riders; r += 1) {
        let persona: Persona | 'pending' =
          r < 2
            ? 'pending'
            : (personas[personaIndex++ % personas.length] ?? 'reliable');
        // Paying off early takes most of a year: only the two oldest branches have had time.
        if (persona === 'finisher' && opened < 300) {
          persona = 'reliable';
        }
        let start: Date;
        if (persona === 'finisher') start = daysAgo(int(290, opened - 15));
        else if (persona === 'defaulter')
          start = daysAgo(int(150, Math.max(160, opened - 15)));
        else if (persona === 'pending') start = daysAgo(int(1, 4));
        else start = daysAgo(int(14, opened - 15));
        const registered = addDays(start, -int(3, 12));

        // Registered by an agent who was working there that day; looked after now by whoever
        // is, since an agent who has left keeps his registrations but not his riders.
        const onDuty = agents.filter(
          (a) => a.joined < registered && (!a.left || a.left > registered),
        );
        const registeredBy = onDuty.length
          ? pick(onDuty)
          : agents.reduce((a, b) => (a.joined < b.joined ? a : b));
        const assigned = registeredBy.active ? registeredBy : pick(active);

        const rider = makeRider(
          branch,
          registeredBy,
          assigned,
          admin,
          registered,
          persona === 'pending'
            ? CustomerStatus.PENDING_KYC
            : CustomerStatus.ACTIVE,
        );
        riderOf.set(rider.id, rider);
        if (persona === 'pending') {
          continue;
        }

        const bike = makeBike(branch, addDays(start, -int(5, 25)), admin);
        let stopDay: Date | null = null;
        let repossessAfter: number | null = null;
        let darkAfter: number | null = null;
        if (persona === 'defaulter') {
          defaulterCount += 1;
          stopDay = daysAgo(int(55, 110));
          if (defaulterCount <= 6) {
            repossessAfter = int(38, 50);
          } else if (defaulterCount <= 9) {
            darkAfter = int(1, 3);
          }
        }
        stories.push({
          rider,
          bike,
          agent: assigned,
          admin,
          finance,
          persona,
          start,
          frequency: chance(branch.code === 'TML' ? 0.75 : 0.62)
            ? LoanFrequency.DAILY
            : LoanFrequency.WEEKLY,
          stopDay,
          repossessAfter,
          darkAfter,
          installer: registeredBy,
        });
      }
    }

    // Assign, fit trackers, write loans.
    const outcomes = new Map<string, LoanOutcome>();
    for (const story of stories) {
      const assignedAt = at(story.start, 9, 30, 60);
      fitTracker(
        story.bike,
        seconds(assignedAt, -int(1800, 7200)),
        story.installer,
      );
      setBikeStatus(
        story.bike,
        BikeStatus.IN_INVENTORY,
        BikeStatus.ASSIGNED,
        'Assigned to rider',
        story.admin,
        assignedAt,
      );
      story.assignmentId = randomUUID();
      rows.assignments.push({
        id: story.assignmentId,
        bikeId: story.bike.id,
        customerId: story.rider.id,
        startedAt: assignedAt,
        assignedById: story.admin.id,
      });
      outcomes.set(story.bike.id, writeLoan(story));
    }

    // Endings: completed loans become sales, repossessions go to the yard, some are resold.
    const resold: Assigned[] = [];
    for (const story of stories) {
      const outcome = outcomes.get(story.bike.id)!;
      const assignment = rows.assignments.find(
        (a) => a.id === story.assignmentId,
      )!;
      if (outcome.status === LoanStatus.COMPLETED && outcome.completedAt) {
        const sold = at(addDays(outcome.completedAt, int(1, 6)), 11, 0, 240);
        if (sold < NOW) {
          setBikeStatus(
            story.bike,
            BikeStatus.ASSIGNED,
            BikeStatus.SOLD,
            'Sold to rider',
            story.admin,
            sold,
          );
          Object.assign(assignment, {
            endedAt: sold,
            endReason: AssignmentEndReason.SOLD,
            endedById: story.admin.id,
            notes:
              'Loan fully paid. Ownership documents handed over at the branch.',
          });
        }
      }
      if (outcome.status === LoanStatus.REPOSSESSED && outcome.closedAt) {
        const when = outcome.closedAt;
        const loanRow = rows.loans.find((l) => l.id === outcome.loanId)!;
        setBikeStatus(
          story.bike,
          BikeStatus.ASSIGNED,
          BikeStatus.REPOSSESSED,
          loanRow.closedReason ?? 'Repossessed',
          story.admin,
          when,
        );
        Object.assign(assignment, {
          endedAt: when,
          endReason: AssignmentEndReason.REPOSSESSED,
          endedById: story.admin.id,
          notes: loanRow.closedReason,
        });
        // Held immobilized in the yard by a staff decision, so arrears logic never lifts it.
        const held = seconds(when, int(600, 3600));
        const priorConfirmed =
          rows.enforcement.find((e) => e.bikeId === story.bike.id)
            ?.confirmedState ?? null;
        rows.enforcementEvents.push({
          bikeId: story.bike.id,
          type: EnforcementEventType.DESIRED_STATE_CHANGED,
          actorUserId: story.admin.id,
          trigger: 'staff',
          fromState: priorConfirmed ?? MobilityState.MOBILE,
          toState: MobilityState.IMMOBILIZED,
          reason: `Held in the ${story.bike.branch.city} yard after repossession`,
          createdAt: held,
        });

        const restock = chance(0.6)
          ? at(addDays(when, int(6, 14)), 10, 0, 300)
          : null;
        const enforcementRow = rows.enforcement.find(
          (e) => e.bikeId === story.bike.id,
        );
        if (restock && restock < daysAgo(3)) {
          setBikeStatus(
            story.bike,
            BikeStatus.REPOSSESSED,
            BikeStatus.IN_INVENTORY,
            'Serviced at the branch: new chain, brake pads and rear tyre',
            story.admin,
            restock,
          );
          const newRider = makeRider(
            story.bike.branch,
            story.agent,
            story.agent,
            story.admin,
            addDays(restock, int(1, 5)),
            CustomerStatus.ACTIVE,
          );
          const start = addDays(restock, int(3, 8));
          if (start < daysAgo(2)) {
            rows.enforcementEvents.push({
              bikeId: story.bike.id,
              type: EnforcementEventType.DESIRED_STATE_CHANGED,
              actorUserId: story.admin.id,
              trigger: 'staff',
              fromState: MobilityState.IMMOBILIZED,
              toState: MobilityState.MOBILE,
              reason: `Released for new rider ${newRider.firstName} ${newRider.lastName}`,
              createdAt: at(start, 9, 0, 20),
            });
            const confirmedId = randomUUID();
            rows.enforcementEvents.push({
              id: confirmedId,
              bikeId: story.bike.id,
              type: EnforcementEventType.STATE_CONFIRMED,
              trigger: 'command-response',
              fromState: MobilityState.IMMOBILIZED,
              toState: MobilityState.MOBILE,
              reason: 'Device reported its output state',
              deviceResponse: 'Setdigout 0 OK',
              createdAt: at(start, 9, 25, 5),
            });
            const upsert = {
              bikeId: story.bike.id,
              desiredState: MobilityState.MOBILE,
              desiredSource: DesiredStateSource.ARREARS,
              confirmedState: MobilityState.MOBILE,
              confirmedAt: at(start, 9, 25, 5),
              blockedReason: null,
              reviewReason: null,
              reviewSince: null,
              pendingCommand: null,
              pendingSentAt: null,
            };
            if (enforcementRow) Object.assign(enforcementRow, upsert);
            else rows.enforcement.push(upsert);
            const next: Assigned = {
              ...story,
              rider: newRider,
              persona: 'reliable',
              start,
              stopDay: null,
              repossessAfter: null,
              darkAfter: null,
              frequency: LoanFrequency.DAILY,
            };
            resold.push(next);
            continue;
          }
        }
        const hold = {
          desiredState: MobilityState.IMMOBILIZED,
          desiredSource: DesiredStateSource.STAFF,
          confirmedState: MobilityState.IMMOBILIZED,
          confirmedAt: seconds(held, 20),
          blockedReason: null,
          reviewReason: null,
          reviewSince: null,
          pendingCommand: null,
          pendingSentAt: null,
        };
        if (enforcementRow) Object.assign(enforcementRow, hold);
        else rows.enforcement.push({ bikeId: story.bike.id, ...hold });
      }
    }
    for (const story of resold) {
      const assignedAt = at(story.start, 9, 30, 60);
      setBikeStatus(
        story.bike,
        BikeStatus.IN_INVENTORY,
        BikeStatus.ASSIGNED,
        'Assigned to rider',
        story.admin,
        assignedAt,
      );
      story.assignmentId = randomUUID();
      rows.assignments.push({
        id: story.assignmentId,
        bikeId: story.bike.id,
        customerId: story.rider.id,
        startedAt: assignedAt,
        assignedById: story.admin.id,
      });
      const before = rows.enforcement.find((e) => e.bikeId === story.bike.id);
      const outcome = writeLoan(story);
      // writeLoan may have pushed a second enforcement row for this bike; keep one.
      const all = rows.enforcement.filter((e) => e.bikeId === story.bike.id);
      if (all.length > 1 && before) {
        const latest = all[all.length - 1];
        Object.assign(before, latest);
        rows.enforcement.splice(rows.enforcement.lastIndexOf(latest), 1);
      }
      outcomes.set(story.bike.id, outcome);
      stories.push(story);
    }

    // Two riders who paid off, collected their bikes, and left.
    const leavers = stories
      .filter((s) => outcomes.get(s.bike.id)?.status === LoanStatus.COMPLETED)
      .slice(0, 2);
    const leaveReasons = [
      'Relocated to Ouagadougou to join family',
      'Stopped riding, took up cocoa farming near Goaso',
    ];
    leavers.forEach((story, i) => {
      const row = rows.customers.find((c) => c.id === story.rider.id)!;
      const when = at(daysAgo(int(5, 30)), 12, 0, 120);
      const assignment = rows.assignments.find(
        (a) => a.id === story.assignmentId,
      )!;
      if (assignment.endedAt) {
        Object.assign(row, {
          status: CustomerStatus.CLOSED,
          deactivatedAt: when,
          deactivationReason: leaveReasons[i],
          updatedAt: when,
        });
      }
    });

    // Staff lock stories: a stolen bike, locked by the field agent, recovered, unlocked.
    const theftStories = stories
      .filter(
        (s) =>
          s.persona === 'reliable' &&
          outcomes.get(s.bike.id)?.status === LoanStatus.ACTIVE &&
          !rows.enforcement.some((e) => e.bikeId === s.bike.id),
      )
      .slice(0, 2);
    const theft = [
      [
        'Rider reported the bike stolen from Kaneshie market',
        'Recovered by police at Kasoa and returned to the rider',
      ],
      [
        'Rider reported the bike taken at night from his compound',
        'Found abandoned near the lorry station, returned to the rider',
      ],
    ] as const;
    theftStories.forEach((story, i) => {
      const day = daysAgo(int(20, 60));
      const lockAt = at(day, 6, 10, 60);
      const unlockAt = at(addDays(day, int(1, 3)), 15, 0, 180);
      rows.enforcementEvents.push({
        bikeId: story.bike.id,
        type: EnforcementEventType.DESIRED_STATE_CHANGED,
        actorUserId: story.agent.id,
        trigger: 'staff',
        fromState: MobilityState.MOBILE,
        toState: MobilityState.IMMOBILIZED,
        reason: theft[i][0],
        createdAt: lockAt,
      });
      rows.enforcementEvents.push({
        bikeId: story.bike.id,
        type: EnforcementEventType.COMMAND_SENT,
        trigger: 'staff',
        fromState: MobilityState.MOBILE,
        toState: MobilityState.IMMOBILIZED,
        reason: 'Desired state differs from confirmed state',
        telemetry: {
          speed: 0,
          ignition: false,
          movement: false,
          hasFix: true,
          online: true,
          recordedAt: seconds(lockAt, 40).toISOString(),
          lastReportedAt: seconds(lockAt, 45).toISOString(),
        },
        detail: { command: 'setdigout 1' },
        createdAt: at(day, 7, 40, 30),
      });
      rows.enforcementEvents.push({
        bikeId: story.bike.id,
        type: EnforcementEventType.STATE_CONFIRMED,
        trigger: 'command-response',
        fromState: MobilityState.MOBILE,
        toState: MobilityState.IMMOBILIZED,
        reason: 'Device reported its output state',
        deviceResponse: 'Setdigout 1 OK',
        createdAt: at(day, 8, 15, 5),
      });
      rows.enforcementEvents.push({
        bikeId: story.bike.id,
        type: EnforcementEventType.DESIRED_STATE_CHANGED,
        actorUserId: story.agent.id,
        trigger: 'staff',
        fromState: MobilityState.IMMOBILIZED,
        toState: MobilityState.MOBILE,
        reason: theft[i][1],
        createdAt: unlockAt,
      });
      rows.enforcementEvents.push({
        bikeId: story.bike.id,
        type: EnforcementEventType.STATE_CONFIRMED,
        trigger: 'command-response',
        fromState: MobilityState.IMMOBILIZED,
        toState: MobilityState.MOBILE,
        reason: 'Device reported its output state',
        deviceResponse: 'Setdigout 0 OK',
        createdAt: seconds(unlockAt, 18),
      });
      rows.enforcement.push({
        bikeId: story.bike.id,
        desiredState: MobilityState.MOBILE,
        desiredSource: DesiredStateSource.ARREARS,
        confirmedState: MobilityState.MOBILE,
        confirmedAt: seconds(unlockAt, 18),
      });
    });

    // Stock: new bikes waiting for riders, two retired, and a few yard bikes.
    for (const branch of BRANCHES) {
      const admin = adminFor(branch);
      const agents = byBranch(branch, StaffRole.FIELD_AGENT);
      for (let i = 0; i < (branch.code === 'TKD' ? 2 : 4); i += 1) {
        const bike = makeBike(branch, daysAgo(int(1, 20)), admin);
        if (chance(0.5) && agents.length) {
          fitTracker(bike, at(daysAgo(int(0, 2)), 11, 0, 240), pick(agents));
          telemetryFor(
            bike,
            { lat: branch.lat + 0.004, lng: branch.lng - 0.003 },
            'parked',
          );
        }
      }
    }
    const retiredReasons = [
      'Written off after an accident on the N1, frame bent',
      'Engine seized, repair costs more than the bike is worth',
    ];
    retiredReasons.forEach((reason, i) => {
      const branch = BRANCHES[i];
      const bike = makeBike(branch, daysAgo(int(250, 300)), adminFor(branch));
      setBikeStatus(
        bike,
        BikeStatus.IN_INVENTORY,
        BikeStatus.RETIRED,
        reason,
        adminFor(branch),
        at(daysAgo(int(20, 90)), 13, 0, 120),
      );
    });

    // Telemetry for bikes on the road.
    for (const story of stories) {
      const outcome = outcomes.get(story.bike.id)!;
      const bikeRow = rows.bikes.find((b) => b.id === story.bike.id)!;
      const assigned = bikeRow.status === BikeStatus.ASSIGNED;
      const currentRider = rows.assignments.find(
        (a) => a.bikeId === story.bike.id && !a.endedAt,
      );
      if (
        !assigned ||
        !currentRider ||
        currentRider.customerId !== story.rider.id
      ) {
        if (bikeRow.status === BikeStatus.REPOSSESSED) {
          telemetryFor(
            story.bike,
            {
              lat: story.bike.branch.lat + 0.004,
              lng: story.bike.branch.lng - 0.003,
            },
            'parked',
          );
        }
        continue;
      }
      if (outcome.dark) {
        const darkSince = rows.enforcement.find(
          (e) => e.bikeId === story.bike.id,
        )?.reviewSince as Date | undefined;
        telemetryFor(
          story.bike,
          story.rider.home,
          'dark',
          darkSince ?? daysAgo(40),
        );
      } else if (outcome.locked) {
        telemetryFor(story.bike, story.rider.home, 'parked');
      } else if (chance(0.94)) {
        telemetryFor(story.bike, story.rider.home, 'riding');
      } else {
        // Tracker quiet for a while: dead battery, or parked in a basement.
        telemetryFor(
          story.bike,
          story.rider.home,
          'dark',
          new Date(NOW.getTime() - int(2, 30) * HOUR_MS),
        );
      }
    }

    // A few Paystack payments that could not be matched to anyone, still waiting.
    for (let i = 0; i < 5; i += 1) {
      const id = randomUUID();
      const paidAt = at(daysAgo(int(0, 12)), int(7, 20), 0, 59);
      const amount = pick([2000, 3500, 5000, 6000, 10000, 45000]);
      rows.payments.push({
        id,
        provider: 'paystack',
        providerReference: `T${digits(15)}`,
        providerTransactionId: String(4_100_000_000 + int(0, 899_999_999)),
        channel: 'mobile_money',
        payerPhone: phone(),
        amountMinor: amount,
        currency: 'GHS',
        paidAt,
        receivedAt: seconds(paidAt, int(2, 20)),
        status: PaymentStatus.UNALLOCATED,
        statusReason: 'The payment did not name a loan',
      });
      ledger(
        LedgerTransactionType.PAYMENT_RECEIVED,
        `paystack payment held unallocated`,
        'GHS',
        paidAt,
        { paymentId: id },
        [
          { account: LedgerAccount.PROVIDER_CLEARING, debit: amount },
          { account: LedgerAccount.UNALLOCATED_FUNDS, credit: amount },
        ],
      );
    }

    // --- write everything, in dependency order ---
    const chunked = async <T>(
      label: string,
      items: T[],
      write: (batch: T[]) => Promise<unknown>,
      size = 2000,
    ) => {
      for (let i = 0; i < items.length; i += size) {
        await write(items.slice(i, i + size));
      }
      console.log(`  ${label.padEnd(24)} ${items.length}`);
    };

    console.log('Writing demo data:');
    await prisma.$transaction(
      async (tx) => {
        await chunked('staff', rows.users, (b) =>
          tx.user.createMany({ data: b }),
        );
        await chunked('staff audit events', rows.staffAudit, (b) =>
          tx.staffAuditEvent.createMany({ data: b }),
        );
        await chunked('riders', rows.customers, (b) =>
          tx.customer.createMany({ data: b }),
        );
        await chunked('rider contacts', rows.contacts, (b) =>
          tx.customerContact.createMany({ data: b }),
        );
        await chunked('bikes', rows.bikes, (b) =>
          tx.bike.createMany({ data: b }),
        );
        await chunked('tracker installations', rows.trackers, (b) =>
          tx.bikeTrackerInstallation.createMany({ data: b }),
        );
        await chunked('bike assignments', rows.assignments, (b) =>
          tx.bikeAssignment.createMany({ data: b }),
        );
        await chunked('bike status changes', rows.statusChanges, (b) =>
          tx.bikeStatusChange.createMany({ data: b }),
        );
        await chunked('loans', rows.loans, (b) =>
          tx.loan.createMany({ data: b }),
        );
        await chunked('installments', rows.installments, (b) =>
          tx.loanInstallment.createMany({ data: b }),
        );
        await chunked('payments', rows.payments, (b) =>
          tx.payment.createMany({ data: b }),
        );
        await chunked('payment allocations', rows.allocations, (b) =>
          tx.paymentAllocation.createMany({ data: b }),
        );
        await chunked('ledger transactions', rows.ledgerTransactions, (b) =>
          tx.ledgerTransaction.createMany({ data: b }),
        );
        await chunked('ledger entries', rows.ledgerEntries, (b) =>
          tx.ledgerEntry.createMany({ data: b }),
        );
        await chunked('enforcement states', rows.enforcement, (b) =>
          tx.bikeEnforcement.createMany({ data: b }),
        );
        await chunked('enforcement events', rows.enforcementEvents, (b) =>
          tx.enforcementEvent.createMany({ data: b }),
        );
        await chunked('rider messages', rows.notifications, (b) =>
          tx.notification.createMany({ data: b }),
        );
        await chunked('staff alerts', rows.alerts, (b) =>
          tx.staffAlert.createMany({ data: b }),
        );
        await chunked(
          'GPS positions',
          rows.positions,
          (b) => tx.bikePosition.createMany({ data: b }),
          5000,
        );
        await chunked('current positions', rows.current, (b) =>
          tx.bikeCurrentPosition.createMany({ data: b }),
        );
      },
      { timeout: 600_000, maxWait: 60_000 },
    );

    // --- check the result against the app's own invariants ---
    const [unbalanced, cacheMismatch] = await Promise.all([
      prisma.$queryRaw<{ n: bigint }[]>`
        SELECT COUNT(*) AS n FROM (
          SELECT "transactionId" FROM "ledger_entries" GROUP BY "transactionId", "currency"
          HAVING SUM("debitMinor") <> SUM("creditMinor")) t`,
      prisma.$queryRaw<{ n: bigint }[]>`
        SELECT COUNT(*) AS n FROM "loans" l
        WHERE COALESCE((SELECT SUM("paidMinor") FROM "loan_installments" i WHERE i."loanId" = l."id"), 0)
           <> COALESCE((SELECT SUM("creditMinor") FROM "ledger_entries" e WHERE e."loanId" = l."id" AND e."account" = 'LOAN_RECEIVABLE'), 0)`,
    ]);
    const statuses = rows.loans.reduce<Record<string, number>>(
      (acc, l) => ({
        ...acc,
        [l.status as string]: (acc[l.status as string] ?? 0) + 1,
      }),
      {},
    );
    const immobilized = rows.enforcement.filter(
      (e) =>
        e.confirmedState === MobilityState.IMMOBILIZED &&
        e.desiredState === MobilityState.IMMOBILIZED,
    );
    const lockedNow = immobilized.filter(
      (e) => e.desiredSource !== DesiredStateSource.STAFF,
    ).length;
    const yardHolds = immobilized.length - lockedNow;
    const collected = rows.payments.reduce((s, p) => s + p.amountMinor, 0);

    console.log('\nChecks:');
    console.log(
      `  unbalanced ledger transactions: ${Number(unbalanced[0]?.n ?? 0)}`,
    );
    console.log(
      `  loans whose cache differs from the ledger: ${Number(cacheMismatch[0]?.n ?? 0)}`,
    );
    console.log('\nSummary:');
    console.log(`  loans by status: ${JSON.stringify(statuses)}`);
    const open = [...outcomes.values()].filter(
      (o) =>
        o.status === LoanStatus.ACTIVE || o.status === LoanStatus.DEFAULTED,
    );
    const overdueOpen = open.filter((o) => o.overdueNow > 0).length;
    const locks = rows.enforcementEvents.filter(
      (e) =>
        e.type === EnforcementEventType.STATE_CONFIRMED &&
        e.toState === MobilityState.IMMOBILIZED,
    ).length;
    const warnings = rows.notifications.filter(
      (n) => n.kind === NotificationKind.LOCKOUT_WARNING,
    ).length;
    const pct = (n: number, d: number) =>
      `${((100 * n) / Math.max(d, 1)).toFixed(1)}%`;
    console.log(
      `  open loans overdue right now: ${overdueOpen} of ${open.length} (${pct(overdueOpen, open.length)})`,
    );
    console.log(
      `  bikes locked for arrears right now: ${lockedNow} (${pct(lockedNow, open.length)} of open loans), plus ${yardHolds} held in yards after repossession`,
    );
    console.log(
      `  over the whole history: ${warnings} warnings, ${locks} locks (${(locks / Math.max(rows.loans.length, 1)).toFixed(1)} per loan)`,
    );
    console.log(
      `  money collected: GHS ${(collected / 100).toLocaleString('en-GB', { minimumFractionDigits: 2 })}`,
    );
    console.log(
      `\nDemo staff sign in at @${DEMO_DOMAIN} with the password ${process.env.DEMO_STAFF_PASSWORD ? 'from DEMO_STAFF_PASSWORD' : `"${password}"`}, e.g.`,
    );
    for (const s of staff.filter((p) => p.active).slice(0, 6)) {
      const email = rows.users.find((u) => u.id === s.id)!.email;
      console.log(`  ${s.role.padEnd(12)} ${email}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
