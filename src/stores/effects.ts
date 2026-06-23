import * as G from '../game';

const floor = (value: number) => Math.trunc(value + 1e-7);

export interface CombatEffects {
  crtChance: number,
  crtDamage: number,
  detDamage: number,
  dhtChance: number,
  tenDamage: number,
  tenMitigation: number,
  damage: number,
  gcd: number,
  ssDamage: number,
  hp: number,
  mp: number,
}

export function calculateCombatEffects(args: {
  job: G.Job,
  jobLevel: G.JobLevel,
  schema: G.JobSchema,
  stats: G.Stats,
  baseStats: G.Stats,
}): CombatEffects | undefined {
  const { job, jobLevel, schema, stats, baseStats } = args;
  const { statModifiers, mainStat, traitDamageMultiplier, partyBonus } = schema;
  if (statModifiers === undefined || mainStat === undefined || traitDamageMultiplier === undefined) return;
  const levelMod = G.jobLevelModifiers[jobLevel];
  const { main, sub, div, det, detTrunc } = levelMod;
  const { CRT, DET, DHT, TEN, SKS, SPS, VIT, PIE, PDMG, MDMG } = stats;
  const attackMainStat = mainStat === 'VIT' ? 'STR' : mainStat;
  const bluAetherialMimicry = job === 'BLU' ? 200 : 0;
  const crtChance = floor(200 * (CRT! - sub) / div + 50 + bluAetherialMimicry) / 1000;
  const crtDamage = floor(200 * (CRT! - sub) / div + 1400) / 1000;
  const detDamage = floor((140 * (DET! - main) / det + 1000) / detTrunc) * detTrunc / 1000;
  const dhtChance = floor(550 * (DHT! - sub) / div + bluAetherialMimicry) / 1000;
  const tenDamage = floor(112 * ((TEN ?? sub) - sub) / div + 1000) / 1000;
  const tenMitigation = floor(200 * ((TEN ?? sub) - sub) / div) / 1000;
  const weaponDamage = floor(main * statModifiers[attackMainStat]! / 1000) +
    ((mainStat === 'MND' || mainStat === 'INT' ? MDMG : PDMG) ?? 0) +
    (job === 'BLU' ? G.bluMdmgAdditions[stats['INT']! - baseStats['INT']!] ?? 0 : 0);
  const mainDamage = floor((mainStat === 'VIT' ? levelMod.apTank : levelMod.ap) *
    (floor((stats[attackMainStat] ?? 0) * (partyBonus ?? 1.05)) - main) / main + 100) / 100;
  const damage = 0.01 * weaponDamage * mainDamage * detDamage * tenDamage * traitDamageMultiplier *
    ((crtDamage - 1) * crtChance + 1) * (0.25 * dhtChance + 1);
  const gcd = calculateGcd({ jobLevel, schema, speed: (SKS ?? SPS)! });
  const ssDamage = floor(130 * ((SKS ?? SPS)! - sub) / div + 1000) / 1000;
  const hp = levelMod.hp * statModifiers.hp +
    floor((mainStat === 'VIT' ? levelMod.vitTank : levelMod.vit) * (VIT! - main));
  const mp = floor(150 * ((PIE ?? main) - main) / div + 200);
  return { crtChance, crtDamage, detDamage, dhtChance, tenDamage, tenMitigation, damage, gcd, ssDamage, hp, mp };
}

export function calculateGcd(args: {
  jobLevel: G.JobLevel,
  schema: G.JobSchema,
  speed: number,
}): number {
  const { jobLevel, schema, speed } = args;
  const { sub, div } = G.jobLevelModifiers[jobLevel];
  const gcdModifier = jobLevel >= 80 && schema.statModifiers?.gcd || 100;
  return floor(floor((1000 - floor(130 * (speed - sub) / div)) * 2500 / 1000) *
    gcdModifier / 1000) / 100;
}
