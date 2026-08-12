/**
 * The public intake application.
 *
 * Declarative on purpose: steps, fields, conditional visibility and tier
 * membership are all DATA, not code. Adding a question is a new entry in this
 * file — no change to the renderer, the API route, or the database (raw answers
 * are stored as JSON alongside the columns they map into).
 *
 * Three tiers, because a single form cannot serve both "I'm curious what I can
 * afford" and "I'm ready to submit to a lender":
 *
 *   ez    — 6 questions. A lead capture. Someone browsing at 11pm will finish it.
 *   short — the working default. Enough to open a real file and build a checklist.
 *   long  — full detail including liabilities and co-borrower.
 *
 * Every borrower-facing string is bilingual. French is Canadian mortgage
 * vocabulary (mise de fonds, taxes foncières, coemprunteur), not a literal
 * translation of the English — a Quebec client reading calque French will not
 * trust the form with their financial data.
 */

export type Locale = 'en' | 'fr';
export type Tier = 'ez' | 'short' | 'long';

export interface Localised {
  en: string;
  fr: string;
}

export type FieldType =
  | 'text'
  | 'email'
  | 'tel'
  | 'number'
  | 'currency'
  | 'select'
  | 'radio'
  | 'checkbox'
  | 'date'
  | 'textarea';

export interface FieldOption {
  value: string;
  label: Localised;
}

export type Answers = Record<string, string | number | boolean | undefined>;

export interface Field {
  id: string;
  type: FieldType;
  label: Localised;
  help?: Localised;
  placeholder?: Localised;
  options?: FieldOption[];
  required?: boolean;
  tiers: Tier[];
  /** Conditional visibility. Absent means always shown. */
  showIf?: (answers: Answers) => boolean;
  min?: number;
  max?: number;
}

export interface Step {
  id: string;
  title: Localised;
  description?: Localised;
  tiers: Tier[];
  fields: Field[];
}

const ALL: Tier[] = ['ez', 'short', 'long'];
const SHORT_UP: Tier[] = ['short', 'long'];
const LONG_ONLY: Tier[] = ['long'];

/** Reads a field as a string regardless of how it was stored. */
const str = (answers: Answers, key: string): string => String(answers[key] ?? '');

const isPurchase = (a: Answers) => str(a, 'dealType') === 'purchase';
const isRefinanceOrRenewal = (a: Answers) =>
  ['refinance', 'renewal', 'heloc'].includes(str(a, 'dealType'));

export const PROVINCES: FieldOption[] = [
  { value: 'AB', label: { en: 'Alberta', fr: 'Alberta' } },
  { value: 'BC', label: { en: 'British Columbia', fr: 'Colombie-Britannique' } },
  { value: 'MB', label: { en: 'Manitoba', fr: 'Manitoba' } },
  { value: 'NB', label: { en: 'New Brunswick', fr: 'Nouveau-Brunswick' } },
  { value: 'NL', label: { en: 'Newfoundland and Labrador', fr: 'Terre-Neuve-et-Labrador' } },
  { value: 'NS', label: { en: 'Nova Scotia', fr: 'Nouvelle-Écosse' } },
  { value: 'NT', label: { en: 'Northwest Territories', fr: 'Territoires du Nord-Ouest' } },
  { value: 'NU', label: { en: 'Nunavut', fr: 'Nunavut' } },
  { value: 'ON', label: { en: 'Ontario', fr: 'Ontario' } },
  { value: 'PE', label: { en: 'Prince Edward Island', fr: 'Île-du-Prince-Édouard' } },
  { value: 'QC', label: { en: 'Quebec', fr: 'Québec' } },
  { value: 'SK', label: { en: 'Saskatchewan', fr: 'Saskatchewan' } },
  { value: 'YT', label: { en: 'Yukon', fr: 'Yukon' } },
];

export const INTAKE_STEPS: Step[] = [
  // ── 1. What are you doing ─────────────────────────────────────────────────
  {
    id: 'goal',
    title: { en: 'What can we help with?', fr: 'Comment pouvons-nous vous aider?' },
    description: {
      en: 'A few quick questions so we can point you in the right direction.',
      fr: 'Quelques questions rapides pour bien vous orienter.',
    },
    tiers: ALL,
    fields: [
      {
        id: 'dealType',
        type: 'radio',
        required: true,
        tiers: ALL,
        label: { en: 'I want to…', fr: 'Je souhaite…' },
        options: [
          { value: 'purchase', label: { en: 'Buy a property', fr: 'Acheter une propriété' } },
          { value: 'refinance', label: { en: 'Refinance my mortgage', fr: 'Refinancer mon hypothèque' } },
          { value: 'renewal', label: { en: 'Renew my mortgage', fr: 'Renouveler mon hypothèque' } },
          { value: 'heloc', label: { en: 'Access my home equity', fr: 'Accéder à la valeur nette' } },
          { value: 'preapproval', label: { en: 'Get pre-approved', fr: 'Obtenir une préapprobation' } },
        ],
      },
      {
        id: 'timeline',
        type: 'select',
        required: true,
        tiers: ALL,
        label: { en: 'When are you hoping to close?', fr: 'Quand espérez-vous conclure?' },
        options: [
          { value: 'asap', label: { en: 'As soon as possible', fr: 'Dès que possible' } },
          { value: '1_3_months', label: { en: '1–3 months', fr: '1 à 3 mois' } },
          { value: '3_6_months', label: { en: '3–6 months', fr: '3 à 6 mois' } },
          { value: '6_plus', label: { en: 'More than 6 months', fr: 'Plus de 6 mois' } },
          { value: 'just_looking', label: { en: 'Just exploring', fr: 'Simplement en exploration' } },
        ],
      },
      {
        id: 'firstTimeBuyer',
        type: 'radio',
        tiers: ALL,
        showIf: isPurchase,
        label: { en: 'Is this your first home?', fr: 'S’agit-il de votre première propriété?' },
        help: {
          en: 'First-time buyers qualify for land transfer tax rebates and other programs.',
          fr: 'Les premiers acheteurs ont droit à des remboursements de droits de mutation et à d’autres programmes.',
        },
        options: [
          { value: 'yes', label: { en: 'Yes', fr: 'Oui' } },
          { value: 'no', label: { en: 'No', fr: 'Non' } },
        ],
      },
    ],
  },

  // ── 2. About you ──────────────────────────────────────────────────────────
  {
    id: 'about',
    title: { en: 'About you', fr: 'À propos de vous' },
    tiers: ALL,
    fields: [
      {
        id: 'fullName',
        type: 'text',
        required: true,
        tiers: ALL,
        label: { en: 'Full name', fr: 'Nom complet' },
      },
      {
        id: 'email',
        type: 'email',
        required: true,
        tiers: ALL,
        label: { en: 'Email', fr: 'Courriel' },
        help: {
          en: 'We’ll send your secure portal login here.',
          fr: 'Nous y enverrons votre accès sécurisé au portail.',
        },
      },
      {
        id: 'phone',
        type: 'tel',
        tiers: ALL,
        label: { en: 'Phone', fr: 'Téléphone' },
      },
      {
        id: 'preferredLanguage',
        type: 'radio',
        tiers: SHORT_UP,
        label: { en: 'Preferred language', fr: 'Langue préférée' },
        options: [
          { value: 'en', label: { en: 'English', fr: 'Anglais' } },
          { value: 'fr', label: { en: 'French', fr: 'Français' } },
        ],
      },
    ],
  },

  // ── 3. The property ───────────────────────────────────────────────────────
  {
    id: 'property',
    title: { en: 'The property', fr: 'La propriété' },
    tiers: ALL,
    fields: [
      {
        id: 'purchasePrice',
        type: 'currency',
        required: true,
        tiers: ALL,
        showIf: isPurchase,
        label: { en: 'Purchase price (or your budget)', fr: 'Prix d’achat (ou votre budget)' },
        placeholder: { en: '750,000', fr: '750 000' },
      },
      {
        id: 'propertyValue',
        type: 'currency',
        required: true,
        tiers: ALL,
        showIf: isRefinanceOrRenewal,
        label: { en: 'Estimated property value', fr: 'Valeur estimée de la propriété' },
      },
      {
        id: 'downPayment',
        type: 'currency',
        required: true,
        tiers: ALL,
        showIf: isPurchase,
        label: { en: 'Down payment available', fr: 'Mise de fonds disponible' },
        help: {
          en: 'Minimum is 5% up to $500,000, then 10% on the portion above.',
          fr: 'Le minimum est de 5 % jusqu’à 500 000 $, puis 10 % sur la portion supérieure.',
        },
      },
      {
        id: 'downPaymentSource',
        type: 'select',
        tiers: SHORT_UP,
        showIf: isPurchase,
        label: { en: 'Where is the down payment coming from?', fr: 'D’où provient la mise de fonds?' },
        help: {
          en: 'Lenders require a 90-day history for the source of these funds.',
          fr: 'Les prêteurs exigent un historique de 90 jours pour la provenance des fonds.',
        },
        options: [
          { value: 'savings', label: { en: 'Savings', fr: 'Épargne' } },
          { value: 'gift', label: { en: 'Gift from family', fr: 'Don familial' } },
          { value: 'sale_of_property', label: { en: 'Sale of another property', fr: 'Vente d’une autre propriété' } },
          { value: 'rrsp', label: { en: 'RRSP / Home Buyers’ Plan', fr: 'REER / Régime d’accession à la propriété' } },
          { value: 'investments', label: { en: 'Investments', fr: 'Placements' } },
          { value: 'other', label: { en: 'Other', fr: 'Autre' } },
        ],
      },
      {
        id: 'propertyProvince',
        type: 'select',
        required: true,
        tiers: SHORT_UP,
        label: { en: 'Province', fr: 'Province' },
        options: PROVINCES,
      },
      {
        id: 'propertyCity',
        type: 'text',
        tiers: SHORT_UP,
        label: { en: 'City', fr: 'Ville' },
      },
      {
        id: 'propertyAddress',
        type: 'text',
        tiers: LONG_ONLY,
        label: { en: 'Street address', fr: 'Adresse' },
        help: {
          en: 'Leave blank if you haven’t chosen a property yet.',
          fr: 'Laissez vide si vous n’avez pas encore choisi de propriété.',
        },
      },
      {
        id: 'propertyType',
        type: 'select',
        tiers: SHORT_UP,
        label: { en: 'Property type', fr: 'Type de propriété' },
        options: [
          { value: 'detached', label: { en: 'Detached house', fr: 'Maison unifamiliale' } },
          { value: 'semi_detached', label: { en: 'Semi-detached', fr: 'Maison jumelée' } },
          { value: 'townhouse', label: { en: 'Townhouse', fr: 'Maison en rangée' } },
          { value: 'condo', label: { en: 'Condominium', fr: 'Copropriété' } },
          { value: 'duplex', label: { en: 'Duplex or multi-unit', fr: 'Duplex ou multilogement' } },
          { value: 'other', label: { en: 'Other', fr: 'Autre' } },
        ],
      },
      {
        id: 'monthlyCondoFees',
        type: 'currency',
        tiers: SHORT_UP,
        showIf: (a) => str(a, 'propertyType') === 'condo',
        label: { en: 'Monthly condo fees', fr: 'Frais de copropriété mensuels' },
        help: {
          en: 'Half of this counts toward your qualifying ratios.',
          fr: 'La moitié de ce montant compte dans vos ratios d’admissibilité.',
        },
      },
      {
        id: 'occupancy',
        type: 'radio',
        tiers: SHORT_UP,
        label: { en: 'How will it be used?', fr: 'Quel en sera l’usage?' },
        options: [
          { value: 'owner_occupied', label: { en: 'I’ll live there', fr: 'J’y habiterai' } },
          { value: 'rental', label: { en: 'Rental / investment', fr: 'Location / investissement' } },
          { value: 'second_home', label: { en: 'Second home', fr: 'Résidence secondaire' } },
        ],
      },
      {
        id: 'annualPropertyTax',
        type: 'currency',
        tiers: LONG_ONLY,
        label: { en: 'Annual property tax', fr: 'Taxes foncières annuelles' },
      },
    ],
  },

  // ── 4. Existing mortgage ──────────────────────────────────────────────────
  {
    id: 'existing',
    title: { en: 'Your current mortgage', fr: 'Votre hypothèque actuelle' },
    tiers: SHORT_UP,
    fields: [
      {
        id: 'existingBalance',
        type: 'currency',
        required: true,
        tiers: SHORT_UP,
        showIf: isRefinanceOrRenewal,
        label: { en: 'Current balance', fr: 'Solde actuel' },
      },
      {
        id: 'existingLender',
        type: 'text',
        tiers: SHORT_UP,
        showIf: isRefinanceOrRenewal,
        label: { en: 'Current lender', fr: 'Prêteur actuel' },
      },
      {
        id: 'maturityDate',
        type: 'date',
        tiers: SHORT_UP,
        showIf: isRefinanceOrRenewal,
        label: { en: 'Maturity date', fr: 'Date d’échéance' },
        help: {
          en: 'Renewing early can carry a penalty — we’ll check whether it’s worth it.',
          fr: 'Un renouvellement anticipé peut entraîner une pénalité — nous vérifierons si cela en vaut la peine.',
        },
      },
      {
        id: 'additionalFundsNeeded',
        type: 'currency',
        tiers: SHORT_UP,
        showIf: (a) => ['refinance', 'heloc'].includes(str(a, 'dealType')),
        label: { en: 'Additional funds needed', fr: 'Fonds supplémentaires requis' },
      },
    ],
  },

  // ── 5. Income ─────────────────────────────────────────────────────────────
  {
    id: 'income',
    title: { en: 'Your income', fr: 'Vos revenus' },
    description: {
      en: 'This determines how much you qualify for. Estimates are fine at this stage.',
      fr: 'Ceci détermine le montant auquel vous êtes admissible. Une estimation suffit à cette étape.',
    },
    tiers: SHORT_UP,
    fields: [
      {
        id: 'employmentType',
        type: 'select',
        required: true,
        tiers: SHORT_UP,
        label: { en: 'Employment type', fr: 'Type d’emploi' },
        options: [
          { value: 'salaried', label: { en: 'Salaried employee', fr: 'Employé salarié' } },
          { value: 'hourly', label: { en: 'Hourly employee', fr: 'Employé à l’heure' } },
          { value: 'self_employed', label: { en: 'Self-employed', fr: 'Travailleur autonome' } },
          { value: 'commission', label: { en: 'Commission', fr: 'À commission' } },
          { value: 'contract', label: { en: 'Contract', fr: 'Contractuel' } },
          { value: 'retired', label: { en: 'Retired / pension', fr: 'Retraité / pension' } },
          { value: 'other', label: { en: 'Other', fr: 'Autre' } },
        ],
      },
      {
        id: 'annualIncome',
        type: 'currency',
        required: true,
        tiers: SHORT_UP,
        label: { en: 'Annual income before tax', fr: 'Revenu annuel avant impôt' },
      },
      {
        id: 'priorYearIncome',
        type: 'currency',
        tiers: SHORT_UP,
        showIf: (a) => ['self_employed', 'commission'].includes(str(a, 'employmentType')),
        label: { en: 'Previous year’s income', fr: 'Revenu de l’année précédente' },
        help: {
          en: 'Variable income is averaged over two years.',
          fr: 'Les revenus variables sont établis sur une moyenne de deux ans.',
        },
      },
      {
        id: 'employerName',
        type: 'text',
        tiers: LONG_ONLY,
        showIf: (a) => !['retired', 'self_employed'].includes(str(a, 'employmentType')),
        label: { en: 'Employer', fr: 'Employeur' },
      },
      {
        id: 'businessName',
        type: 'text',
        tiers: LONG_ONLY,
        showIf: (a) => str(a, 'employmentType') === 'self_employed',
        label: { en: 'Business name', fr: 'Nom de l’entreprise' },
      },
      {
        id: 'isIncorporated',
        type: 'radio',
        tiers: LONG_ONLY,
        showIf: (a) => str(a, 'employmentType') === 'self_employed',
        label: { en: 'Are you incorporated?', fr: 'Êtes-vous constitué en société?' },
        options: [
          { value: 'yes', label: { en: 'Yes', fr: 'Oui' } },
          { value: 'no', label: { en: 'No', fr: 'Non' } },
        ],
      },
      {
        id: 'yearsAtJob',
        type: 'number',
        tiers: LONG_ONLY,
        min: 0,
        max: 60,
        label: { en: 'Years in this role or business', fr: 'Années dans ce poste ou cette entreprise' },
      },
      {
        id: 'monthlyRentalIncome',
        type: 'currency',
        tiers: LONG_ONLY,
        showIf: (a) => str(a, 'occupancy') === 'rental',
        label: { en: 'Expected monthly rent', fr: 'Loyer mensuel prévu' },
      },
    ],
  },

  // ── 6. Debts ──────────────────────────────────────────────────────────────
  {
    id: 'debts',
    title: { en: 'Your other debts', fr: 'Vos autres dettes' },
    description: {
      en: 'Monthly payments on everything else you owe. This affects how much you qualify for.',
      fr: 'Les paiements mensuels de vos autres dettes. Cela influence le montant admissible.',
    },
    tiers: LONG_ONLY,
    fields: [
      {
        id: 'monthlyCarPayments',
        type: 'currency',
        tiers: LONG_ONLY,
        label: { en: 'Car loans / leases (monthly)', fr: 'Prêts ou locations auto (mensuel)' },
      },
      {
        id: 'monthlyCreditCardPayments',
        type: 'currency',
        tiers: LONG_ONLY,
        label: { en: 'Credit card minimums (monthly)', fr: 'Paiements minimums de cartes de crédit (mensuel)' },
      },
      {
        id: 'monthlyLoanPayments',
        type: 'currency',
        tiers: LONG_ONLY,
        label: { en: 'Student or personal loans (monthly)', fr: 'Prêts étudiants ou personnels (mensuel)' },
      },
      {
        id: 'monthlyOtherDebt',
        type: 'currency',
        tiers: LONG_ONLY,
        label: { en: 'Anything else (monthly)', fr: 'Autres dettes (mensuel)' },
      },
    ],
  },

  // ── 7. Co-borrower ────────────────────────────────────────────────────────
  {
    id: 'coborrower',
    title: { en: 'Anyone applying with you?', fr: 'Quelqu’un présente-t-il une demande avec vous?' },
    tiers: SHORT_UP,
    fields: [
      {
        id: 'hasCoBorrower',
        type: 'radio',
        tiers: SHORT_UP,
        label: { en: 'Are you applying with someone else?', fr: 'Faites-vous une demande avec une autre personne?' },
        options: [
          { value: 'no', label: { en: 'No, just me', fr: 'Non, seulement moi' } },
          { value: 'yes', label: { en: 'Yes', fr: 'Oui' } },
        ],
      },
      {
        id: 'coBorrowerName',
        type: 'text',
        required: true,
        tiers: SHORT_UP,
        showIf: (a) => str(a, 'hasCoBorrower') === 'yes',
        label: { en: 'Their full name', fr: 'Son nom complet' },
      },
      {
        id: 'coBorrowerEmail',
        type: 'email',
        required: true,
        tiers: SHORT_UP,
        showIf: (a) => str(a, 'hasCoBorrower') === 'yes',
        label: { en: 'Their email', fr: 'Son courriel' },
        help: {
          en: 'We’ll send them their own secure login — they never share yours.',
          fr: 'Nous lui enverrons son propre accès sécurisé — jamais le vôtre.',
        },
      },
      {
        id: 'coBorrowerRelationship',
        type: 'select',
        tiers: LONG_ONLY,
        showIf: (a) => str(a, 'hasCoBorrower') === 'yes',
        label: { en: 'Relationship', fr: 'Lien' },
        options: [
          { value: 'spouse', label: { en: 'Spouse or partner', fr: 'Conjoint(e)' } },
          { value: 'family', label: { en: 'Family member', fr: 'Membre de la famille' } },
          { value: 'friend', label: { en: 'Friend', fr: 'Ami(e)' } },
          { value: 'business', label: { en: 'Business partner', fr: 'Partenaire d’affaires' } },
        ],
      },
    ],
  },

  // ── 8. Anything else ──────────────────────────────────────────────────────
  {
    id: 'notes',
    title: { en: 'Anything else we should know?', fr: 'Autre chose à nous signaler?' },
    tiers: ALL,
    fields: [
      {
        id: 'notes',
        type: 'textarea',
        tiers: ALL,
        label: { en: 'Optional', fr: 'Facultatif' },
        placeholder: {
          en: 'Self-employed, recently changed jobs, credit history questions — anything at all.',
          fr: 'Travailleur autonome, changement d’emploi récent, questions de crédit — tout est utile.',
        },
      },
      {
        id: 'consent',
        type: 'checkbox',
        required: true,
        tiers: ALL,
        label: {
          en: 'I agree to be contacted about my mortgage enquiry, and understand my information will be used to assess my application.',
          fr: 'J’accepte d’être contacté au sujet de ma demande hypothécaire et je comprends que mes renseignements serviront à évaluer ma demande.',
        },
      },
    ],
  },
];

/** Fields visible for a tier given the answers so far. */
export function visibleFields(step: Step, tier: Tier, answers: Answers): Field[] {
  return step.fields.filter(
    (field) => field.tiers.includes(tier) && (!field.showIf || field.showIf(answers)),
  );
}

/** Steps that have at least one visible field. Empty steps are skipped entirely. */
export function visibleSteps(tier: Tier, answers: Answers): Step[] {
  return INTAKE_STEPS.filter(
    (step) => step.tiers.includes(tier) && visibleFields(step, tier, answers).length > 0,
  );
}

/** Required visible fields that are still empty. */
export function missingRequired(step: Step, tier: Tier, answers: Answers): Field[] {
  return visibleFields(step, tier, answers).filter((field) => {
    if (!field.required) return false;
    const value = answers[field.id];
    if (field.type === 'checkbox') return value !== true;
    return value === undefined || value === '' || value === null;
  });
}

export const TIER_META: Record<Tier, { label: Localised; blurb: Localised; minutes: number }> = {
  ez: {
    label: { en: 'Quick estimate', fr: 'Estimation rapide' },
    blurb: {
      en: 'A handful of questions. Find out roughly where you stand.',
      fr: 'Quelques questions. Situez-vous rapidement.',
    },
    minutes: 2,
  },
  short: {
    label: { en: 'Start my application', fr: 'Commencer ma demande' },
    blurb: {
      en: 'Enough to open your file and tell you exactly which documents you’ll need.',
      fr: 'Assez pour ouvrir votre dossier et préciser les documents requis.',
    },
    minutes: 6,
  },
  long: {
    label: { en: 'Full application', fr: 'Demande complète' },
    blurb: {
      en: 'Everything up front, so nothing holds your file up later.',
      fr: 'Tout dès le départ, pour éviter les retards plus tard.',
    },
    minutes: 12,
  },
};
