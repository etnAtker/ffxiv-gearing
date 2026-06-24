import * as G from '../game';
import { calculateCombatEffects, calculateGcd } from '../stores/effects';
import type { CombatEffects } from '../stores/effects';
import type { GearOptimizationConfig, GearOptimizationInput, GearOptimizationProgress,
  GearOptimizationReport, GearOptimizationResult, MateriaAssignment, OptimizerFoodInput,
  OptimizerGearInput } from './GearOptimizerTypes';

export type { GearOptimizationConfig, GearOptimizationInput, GearOptimizationProgress,
  GearOptimizationReport, GearOptimizationResult, MateriaAssignment } from './GearOptimizerTypes';

const floor = (value: number) => Math.trunc(value + 1e-7);

interface LocalPlan {
  slot: number,
  gearId: G.GearId,
  itemId: number,
  itemIds: number[],
  selectedGears: [number, G.GearId][],
  stats: G.Stats,
  statEntries: [number, number][],
  speed: number,
  equippedLevelContribution: number,
  equippedLevelWeight: number,
  materiaAssignments: MateriaAssignment[],
  materiaAssignmentsByGear: [G.GearId, MateriaAssignment[]][],
  changeCount: number,
  materiaCount: number,
}

interface StatePool {
  statsWithoutFood: Float64Array[],
  speed: number[],
  prevStateIndex: number[],
  planIndex: number[],
  equippedLevelTotal: number[],
  equippedLevelWeight: number[],
  changeCount: number[],
  materiaCount: number[],
  score: number[],
}

interface CandidateSlotPlans {
  slot: number,
  name: string,
  planIndexes: number[],
}

interface SpeedRange {
  min: number,
  max: number,
}

interface ScoredState {
  stateIndex: number,
  score: number,
}

interface SkylinePoint {
  stateIndex: number,
  values: number[],
}

interface LocalMateriaState {
  stats: G.Stats,
  assignments: MateriaAssignment[],
}

type SparseFenwickNode = Map<number, number | SparseFenwickNode>;

const smallBucketSkylineThreshold = 64;
const objectiveEpsilon = 1e-9;

const optimizerStats = (Object.keys(G.statNames) as G.Stat[])
  .filter(stat => stat !== 'main' && stat !== 'secondary');
const optimizerStatIndex = new Map<G.Stat, number>(optimizerStats.map((stat, i) => [stat, i]));

export function optimizeGearset(
  input: GearOptimizationInput,
  config: GearOptimizationConfig,
  onProgress: (progress: GearOptimizationProgress) => void = () => undefined,
): GearOptimizationReport {
  const schema = G.jobSchemas[input.job];
  if (schema.mainStat === undefined) {
    return { results: [], error: '装备优化仅支持战斗职业。', candidateCount: 0, stateCount: 0 };
  }
  const configError = validateOptimizationConfig(schema, config);
  if (configError !== undefined) {
    return { results: [], error: configError, candidateCount: 0, stateCount: 0 };
  }
  const speedStat = getSpeedStat(schema);
  const requiredTen = calculateRequiredTen(schema, input.jobLevel, config);
  const speedRange = getAllowedSpeedRange(input, schema, speedStat, config);
  if (speedRange === undefined) {
    return { results: [], error: '没有任何咏速/技速值可以满足 GCD 约束。', candidateCount: 0, stateCount: 0 };
  }
  const fixedDuplicate = findFixedDuplicate(input);
  if (fixedDuplicate !== undefined) {
    return { results: [], error: `已固定装备中存在重复物品：${fixedDuplicate.name}。`, candidateCount: 0, stateCount: 0 };
  }

  onProgress({ phase: '生成局部方案', current: 0, total: input.candidateSlots.length });
  const localPlans: LocalPlan[] = [];
  const candidateSlots = buildCandidateSlotPlans(input, speedStat, speedRange, localPlans, onProgress);

  if (input.foodCandidates.length === 0) {
    return { results: [], error: '没有可用食品候选。', candidateCount: 0, stateCount: 0 };
  }
  for (const slot of candidateSlots) {
    if (slot.planIndexes.length === 0) {
      return { results: [], error: `${slot.name}没有可用装备候选。`, candidateCount: 0, stateCount: 0 };
    }
  }

  const benefitStats = getBenefitStats(schema, speedStat).map(stat => getStatIndex(stat));
  const remainingMaxSpeeds = calculateRemainingMaxSpeeds(candidateSlots, localPlans);
  const remainingMaxTen = calculateRemainingMaxStat(candidateSlots, localPlans, 'TEN');
  const pool = createStatePool();
  let states = [addInitialState(pool, input, speedStat)];
  let stateCount = states.length;
  for (let i = 0; i < candidateSlots.length; i++) {
    const nextStates: number[] = [];
    for (const stateIndex of states) {
      for (const planIndex of candidateSlots[i].planIndexes) {
        const plan = localPlans[planIndex];
        if (hasUsedAnyItemId(pool, localPlans, stateIndex, plan.itemIds)) continue;
        const nextSpeed = pool.speed[stateIndex] + plan.speed;
        if (nextSpeed > speedRange.max) continue;
        if (nextSpeed + remainingMaxSpeeds[i + 1] < speedRange.min) continue;
        if (!canReachRequiredTen(pool, stateIndex, plan, remainingMaxTen[i + 1], requiredTen, input.foodCandidates)) {
          continue;
        }
        const nextIndex = mergeState(pool, stateIndex, plan, planIndex);
        nextStates.push(nextIndex);
      }
    }
    states = pruneStates(pool, nextStates, benefitStats, input, schema, config);
    stateCount = Math.max(stateCount, states.length);
    onProgress({ phase: '搜索装备组合', current: i + 1, total: candidateSlots.length, states: states.length });
    if (states.length === 0) break;
  }

  onProgress({ phase: '枚举食品', current: 0, total: states.length, states: states.length });
  const results = finalizeResults(input, schema, pool, states, localPlans, config, speedStat)
    .sort((a, b) => compareResults(a, b, config))
    .slice(0, config.resultLimit);
  onProgress({ phase: '完成', current: 1, total: 1, states: results.length });
  return {
    results,
    error: results.length === 0 ? '没有找到满足约束的方案。' : undefined,
    candidateCount: localPlans.length,
    stateCount,
  };
}

function getSpeedStat(schema: G.JobSchema): 'SKS' | 'SPS' {
  return schema.stats.includes('SPS') ? 'SPS' : 'SKS';
}

function validateOptimizationConfig(
  schema: G.JobSchema,
  config: GearOptimizationConfig,
): string | undefined {
  if (config.minTenMitigation !== undefined) {
    if (!schema.stats.includes('TEN')) return;
    if (!Number.isFinite(config.minTenMitigation) ||
      config.minTenMitigation < 0 ||
      config.minTenMitigation >= 1) {
      return '最低减伤率必须大于等于 0 且小于 100%。';
    }
  }
}

function calculateRequiredTen(
  schema: G.JobSchema,
  jobLevel: G.JobLevel,
  config: GearOptimizationConfig,
): number | undefined {
  if (config.minTenMitigation === undefined) return;
  if (!schema.stats.includes('TEN')) return;
  const { sub, div } = G.jobLevelModifiers[jobLevel];
  return Math.ceil(config.minTenMitigation * 1000 * div / 200 + sub - 1e-7);
}

function getBenefitStats(schema: G.JobSchema, speedStat: G.Stat): G.Stat[] {
  const ret: G.Stat[] = [];
  if (schema.mainStat !== undefined && schema.mainStat !== 'VIT') {
    ret.push(schema.mainStat);
  } else {
    ret.push('STR');
  }
  if (schema.mainStat === 'INT' || schema.mainStat === 'MND') {
    ret.push('MDMG');
  } else {
    ret.push('PDMG');
  }
  for (const stat of ['CRT', 'DET', 'DHT', 'TEN'] as G.Stat[]) {
    if (stat !== speedStat && schema.stats.includes(stat)) ret.push(stat);
  }
  return ret;
}

function getAllowedSpeedRange(
  input: GearOptimizationInput,
  schema: G.JobSchema,
  speedStat: G.Stat,
  config: GearOptimizationConfig,
): SpeedRange | undefined {
  const minGcd = config.targetGcd ?? config.minGcd ?? 0;
  const maxGcd = config.targetGcd ?? config.maxGcd ?? Infinity;
  let min = Infinity;
  let max = -Infinity;
  const base = input.baseStats[speedStat] ?? G.jobLevelModifiers[input.jobLevel].sub;
  const realisticMax = base + 5000;
  for (let speed = 0; speed <= realisticMax; speed++) {
    const gcd = calculateGcd({ jobLevel: input.jobLevel, schema, speed });
    if (gcd >= minGcd && gcd <= maxGcd) {
      min = Math.min(min, speed);
      max = Math.max(max, speed);
    }
  }
  return min === Infinity ? undefined : { min, max };
}

function findFixedDuplicate(input: GearOptimizationInput): OptimizerGearInput | undefined {
  const used = new Map<number, OptimizerGearInput>();
  for (const slot of input.candidateSlots) {
    for (const gear of slot.plans) {
      if (!gear.fixed) continue;
      const itemId = Math.abs(gear.id);
      if (used.has(itemId)) return gear;
      used.set(itemId, gear);
    }
  }
}

function buildCandidateSlotPlans(
  input: GearOptimizationInput,
  speedStat: G.Stat,
  speedRange: SpeedRange,
  localPlans: LocalPlan[],
  onProgress: (progress: GearOptimizationProgress) => void,
): CandidateSlotPlans[] {
  const ret: CandidateSlotPlans[] = [];
  const ringSlots = input.candidateSlots.filter(slot => Math.abs(slot.slot) === 12);
  for (let i = 0; i < input.candidateSlots.length; i++) {
    const slot = input.candidateSlots[i];
    if (slot.slot === -12) {
      onProgress({ phase: '生成局部方案', current: i + 1, total: input.candidateSlots.length });
      continue;
    }
    if (slot.slot === 12 && ringSlots.length === 2) {
      const plans = buildRingPairPlans(input, ringSlots[0], ringSlots[1], speedStat)
        .filter(plan => plan.speed <= speedRange.max);
      ret.push(addCandidateSlotPlans(slot.slot, slot.name, plans, localPlans));
    } else {
      const plans = slot.plans
        .flatMap(gear => buildLocalPlans(input, gear, speedStat))
        .filter(plan => plan.speed <= speedRange.max);
      ret.push(addCandidateSlotPlans(slot.slot, slot.name, plans, localPlans));
    }
    onProgress({ phase: '生成局部方案', current: i + 1, total: input.candidateSlots.length });
  }
  return ret;
}

function addCandidateSlotPlans(
  slot: number,
  name: string,
  plans: LocalPlan[],
  localPlans: LocalPlan[],
): CandidateSlotPlans {
  const planIndexes = plans.map(plan => {
    const index = localPlans.length;
    localPlans.push(plan);
    return index;
  });
  return { slot, name, planIndexes };
}

function buildRingPairPlans(
  input: GearOptimizationInput,
  leftSlot: GearOptimizationInput['candidateSlots'][number],
  rightSlot: GearOptimizationInput['candidateSlots'][number],
  speedStat: G.Stat,
): LocalPlan[] {
  const leftPlans = leftSlot.plans.flatMap(gear => buildLocalPlans(input, gear, speedStat));
  const rightPlans = rightSlot.plans.flatMap(gear => buildLocalPlans(input, gear, speedStat));
  const ret: LocalPlan[] = [];
  for (const left of leftPlans) {
    for (const right of rightPlans) {
      if (left.itemId === right.itemId) continue;
      ret.push(combineLocalPlans(left, right, speedStat));
    }
  }
  return pruneLocalPlans(ret, getBenefitStats(G.jobSchemas[input.job], speedStat));
}

function combineLocalPlans(left: LocalPlan, right: LocalPlan, speedStat: G.Stat): LocalPlan {
  const stats = addStats(left.stats, right.stats);
  const statValues = statsToArray(stats);
  return {
    slot: left.slot,
    gearId: left.gearId,
    itemId: left.itemId,
    itemIds: [...left.itemIds, ...right.itemIds],
    selectedGears: [...left.selectedGears, ...right.selectedGears],
    stats,
    statEntries: statValuesToEntries(statValues),
    speed: stats[speedStat] ?? 0,
    equippedLevelContribution: left.equippedLevelContribution + right.equippedLevelContribution,
    equippedLevelWeight: left.equippedLevelWeight + right.equippedLevelWeight,
    materiaAssignments: [...left.materiaAssignments, ...right.materiaAssignments],
    materiaAssignmentsByGear: [
      ...left.materiaAssignmentsByGear,
      ...right.materiaAssignmentsByGear,
    ],
    changeCount: left.changeCount + right.changeCount,
    materiaCount: left.materiaCount + right.materiaCount,
  };
}

function buildLocalPlans(input: GearOptimizationInput, gear: OptimizerGearInput, speedStat: G.Stat): LocalPlan[] {
  const emptyMaterias = gear.syncedLevel === undefined
    ? gear.materias.filter(materia => materia.fixedStat === undefined)
    : [];
  const materiaOptions = emptyMaterias.map(materia => {
    if (materia.optionGrade === undefined) return [];
    return materia.optionStats.map(stat => ({ index: materia.index, stat, grade: materia.optionGrade! }));
  }).filter(options => options.length > 0);
  if (materiaOptions.length === 0) {
    return [buildLocalPlan(gear, speedStat, [])];
  }
  let states = new Map<string, LocalMateriaState>();
  const initialStats = calculateGearStats(gear, []);
  states.set(statsKey(initialStats), { stats: initialStats, assignments: [] });
  for (const options of materiaOptions) {
    const nextStates = new Map<string, LocalMateriaState>();
    for (const state of states.values()) {
      for (const option of options) {
        const stats = applyMateriaToGearStats(gear, state.stats, option);
        const assignments = [...state.assignments, option];
        const key = statsKey(stats);
        const existing = nextStates.get(key);
        if (existing === undefined || compareMateriaAssignments(assignments, existing.assignments) < 0) {
          nextStates.set(key, { stats, assignments });
        }
      }
    }
    states = nextStates;
  }
  const plans = Array.from(states.values(), state => buildLocalPlan(gear, speedStat, state.assignments, state.stats));
  return pruneLocalPlans(plans, getBenefitStats(G.jobSchemas[input.job], speedStat));
}

function buildLocalPlan(
  gear: OptimizerGearInput,
  speedStat: G.Stat,
  assignments: MateriaAssignment[],
  stats = calculateGearStats(gear, assignments),
): LocalPlan {
  const statValues = statsToArray(stats);
  const materiaAssignments = assignments.slice();
  return {
    slot: gear.slot,
    gearId: gear.id,
    itemId: Math.abs(gear.id),
    itemIds: [Math.abs(gear.id)],
    selectedGears: [[gear.slot, gear.id]],
    stats,
    statEntries: statValuesToEntries(statValues),
    speed: stats[speedStat] ?? 0,
    equippedLevelContribution: gear.level * gear.slotWeight,
    equippedLevelWeight: gear.slotWeight,
    materiaAssignments,
    materiaAssignmentsByGear: materiaAssignments.length > 0 ? [[gear.id, materiaAssignments]] : [],
    changeCount: gear.fixed ? 0 : 1,
    materiaCount: materiaAssignments.length,
  };
}

function calculateGearStats(gear: OptimizerGearInput, assignments: MateriaAssignment[]): G.Stats {
  const stats: G.Stats = { ...gear.bareStats };
  if (gear.syncedLevel !== undefined) {
    for (const [ stat, value ] of Object.entries(stats) as G.StatPairs) {
      stats[stat] = Math.min(value, gear.syncedCaps![stat]!);
    }
    if (gear.syncedLevel === 700 && gear.occultStats !== undefined) {
      for (const [ stat, value ] of Object.entries(gear.occultStats) as G.StatPairs) {
        stats[stat] = (stats[stat] ?? 0) + value;
      }
    }
    return stats;
  }
  const materiaStats: G.Stats = {};
  for (const materia of gear.materias) {
    if (materia.fixedStat !== undefined) {
      materiaStats[materia.fixedStat] = (materiaStats[materia.fixedStat] ?? 0) +
        G.materias[materia.fixedStat]![materia.fixedGrade! - 1];
    }
  }
  for (const assignment of assignments) {
    materiaStats[assignment.stat] = (materiaStats[assignment.stat] ?? 0) +
      G.materias[assignment.stat]![assignment.grade - 1];
  }
  if (gear.materiaSlot > 0) {
    for (const [ stat, value ] of Object.entries(materiaStats) as G.StatPairs) {
      const base = stats[stat] ?? 0;
      stats[stat] = Math.min(base + value, Math.max(base, gear.caps[stat]!));
    }
  }
  return stats;
}

function applyMateriaToGearStats(
  gear: OptimizerGearInput,
  currentStats: G.Stats,
  assignment: MateriaAssignment,
): G.Stats {
  const stats = { ...currentStats };
  if (gear.materiaSlot <= 0) return stats;
  const materiaValue = G.materias[assignment.stat]![assignment.grade - 1];
  const base = gear.bareStats[assignment.stat] ?? 0;
  stats[assignment.stat] = Math.min(
    (stats[assignment.stat] ?? 0) + materiaValue,
    Math.max(base, gear.caps[assignment.stat]!),
  );
  return stats;
}

function pruneLocalPlans(plans: LocalPlan[], benefitStats: G.Stat[]): LocalPlan[] {
  const uniquePlans = uniqueLocalPlans(plans);
  return uniquePlans.filter((plan, i) => !uniquePlans.some((other, j) => i !== j &&
    other.speed === plan.speed &&
    dominates(other.stats, plan.stats, benefitStats)));
}

function uniqueLocalPlans(plans: LocalPlan[]): LocalPlan[] {
  const seen = new Set<string>();
  const ret: LocalPlan[] = [];
  for (const plan of plans) {
    const key = [
      plan.speed,
      Object.entries(plan.stats).sort(([a], [b]) => a.localeCompare(b))
        .map(([stat, value]) => `${stat}:${value}`)
        .join(','),
      plan.materiaAssignments.map(assignment => `${assignment.index}:${assignment.stat}:${assignment.grade}`).join(','),
    ].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    ret.push(plan);
  }
  return ret;
}

function statsKey(stats: G.Stats): string {
  return Object.entries(stats).sort(([a], [b]) => a.localeCompare(b))
    .map(([stat, value]) => `${stat}:${value}`)
    .join(',');
}

function compareMateriaAssignments(a: MateriaAssignment[], b: MateriaAssignment[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i].index !== b[i].index) return a[i].index - b[i].index;
    if (a[i].stat !== b[i].stat) return a[i].stat.localeCompare(b[i].stat);
    if (a[i].grade !== b[i].grade) return a[i].grade - b[i].grade;
  }
  return a.length - b.length;
}

function addStats(a: G.Stats, b: G.Stats): G.Stats {
  const ret: G.Stats = { ...a };
  for (const [ stat, value ] of Object.entries(b) as G.StatPairs) {
    ret[stat] = (ret[stat] ?? 0) + value;
  }
  return ret;
}

function createStatePool(): StatePool {
  return {
    statsWithoutFood: [],
    speed: [],
    prevStateIndex: [],
    planIndex: [],
    equippedLevelTotal: [],
    equippedLevelWeight: [],
    changeCount: [],
    materiaCount: [],
    score: [],
  };
}

function addInitialState(pool: StatePool, input: GearOptimizationInput, speedStat: G.Stat): number {
  const statsWithoutFood = statsToArray(input.baseStats);
  return addState(pool, {
    statsWithoutFood,
    speed: input.baseStats[speedStat] ?? G.jobLevelModifiers[input.jobLevel].sub,
    prevStateIndex: -1,
    planIndex: -1,
    equippedLevelTotal: 0,
    equippedLevelWeight: 0,
    changeCount: 0,
    materiaCount: 0,
  });
}

function mergeState(pool: StatePool, stateIndex: number, plan: LocalPlan, planIndex: number): number {
  const statsWithoutFood = pool.statsWithoutFood[stateIndex].slice();
  for (const [ statIndex, value ] of plan.statEntries) {
    statsWithoutFood[statIndex] += value;
  }
  return addState(pool, {
    statsWithoutFood,
    speed: pool.speed[stateIndex] + plan.speed,
    prevStateIndex: stateIndex,
    planIndex,
    equippedLevelTotal: pool.equippedLevelTotal[stateIndex] + plan.equippedLevelContribution,
    equippedLevelWeight: pool.equippedLevelWeight[stateIndex] + plan.equippedLevelWeight,
    changeCount: pool.changeCount[stateIndex] + plan.changeCount,
    materiaCount: pool.materiaCount[stateIndex] + plan.materiaCount,
  });
}

function addState(pool: StatePool, state: {
  statsWithoutFood: Float64Array,
  speed: number,
  prevStateIndex: number,
  planIndex: number,
  equippedLevelTotal: number,
  equippedLevelWeight: number,
  changeCount: number,
  materiaCount: number,
}): number {
  const index = pool.speed.length;
  pool.statsWithoutFood.push(state.statsWithoutFood);
  pool.speed.push(state.speed);
  pool.prevStateIndex.push(state.prevStateIndex);
  pool.planIndex.push(state.planIndex);
  pool.equippedLevelTotal.push(state.equippedLevelTotal);
  pool.equippedLevelWeight.push(state.equippedLevelWeight);
  pool.changeCount.push(state.changeCount);
  pool.materiaCount.push(state.materiaCount);
  pool.score.push(NaN);
  return index;
}

function hasUsedAnyItemId(pool: StatePool, localPlans: LocalPlan[], stateIndex: number, itemIds: number[]): boolean {
  for (let index = stateIndex; index >= 0; index = pool.prevStateIndex[index]) {
    const planIndex = pool.planIndex[index];
    if (planIndex < 0) continue;
    const usedItemIds = localPlans[planIndex].itemIds;
    if (itemIds.some(itemId => usedItemIds.includes(itemId))) return true;
  }
  return false;
}

function calculateRemainingMaxSpeeds(candidateSlots: CandidateSlotPlans[], localPlans: LocalPlan[]): number[] {
  const ret = new Array(candidateSlots.length + 1).fill(0);
  for (let i = candidateSlots.length - 1; i >= 0; i--) {
    let maxSpeed = 0;
    for (const planIndex of candidateSlots[i].planIndexes) {
      maxSpeed = Math.max(maxSpeed, localPlans[planIndex].speed);
    }
    ret[i] = ret[i + 1] + maxSpeed;
  }
  return ret;
}

function calculateRemainingMaxStat(
  candidateSlots: CandidateSlotPlans[],
  localPlans: LocalPlan[],
  stat: G.Stat,
): number[] {
  const ret = new Array(candidateSlots.length + 1).fill(0);
  for (let i = candidateSlots.length - 1; i >= 0; i--) {
    let maxValue = 0;
    for (const planIndex of candidateSlots[i].planIndexes) {
      maxValue = Math.max(maxValue, localPlans[planIndex].stats[stat] ?? 0);
    }
    ret[i] = ret[i + 1] + maxValue;
  }
  return ret;
}

function canReachRequiredTen(
  pool: StatePool,
  stateIndex: number,
  plan: LocalPlan,
  remainingMaxTen: number,
  requiredTen: number | undefined,
  foodCandidates: OptimizerFoodInput[],
): boolean {
  if (requiredTen === undefined) return true;
  const tenIndex = getStatIndex('TEN');
  const optimisticTen = pool.statsWithoutFood[stateIndex][tenIndex] + (plan.stats.TEN ?? 0) + remainingMaxTen;
  for (const food of foodCandidates) {
    if (applyFoodStat(optimisticTen, food, 'TEN') >= requiredTen) return true;
  }
  return false;
}

function pruneStates(
  pool: StatePool,
  states: number[],
  benefitStats: number[],
  input: GearOptimizationInput,
  schema: G.JobSchema,
  config: GearOptimizationConfig,
): number[] {
  const bySpeed = new Map<number, number[]>();
  for (const stateIndex of states) {
    const speed = pool.speed[stateIndex];
    const bucket = bySpeed.get(speed) ?? [];
    bucket.push(stateIndex);
    bySpeed.set(speed, bucket);
  }
  const ret: number[] = [];
  for (const bucket of bySpeed.values()) {
    const scoredBucket = pruneByObjectiveRatio(pool, bucket, input, schema, config)
      .sort((a, b) => b.score - a.score);
    for (const stateIndex of buildParetoFrontier(pool, scoredBucket, benefitStats)) {
      ret.push(stateIndex);
    }
  }
  return ret;
}

function pruneByObjectiveRatio(
  pool: StatePool,
  states: number[],
  input: GearOptimizationInput,
  schema: G.JobSchema,
  config: GearOptimizationConfig,
): ScoredState[] {
  const scoredStates = states.map(stateIndex => {
    const score = scoreState(pool, stateIndex, input, schema);
    return { stateIndex, score };
  });
  const ratio = config.pruneRatio;
  if (ratio === undefined || ratio <= 0 || ratio >= 100) return scoredStates;
  const bestScore = scoredStates.reduce((best, item) => Math.max(best, item.score), -Infinity);
  const threshold = bestScore * ratio / 100;
  return scoredStates.filter(item => item.score >= threshold);
}

function buildParetoFrontier(pool: StatePool, scoredStates: ScoredState[], benefitStats: number[]): number[] {
  if (scoredStates.length < smallBucketSkylineThreshold) {
    return buildParetoFrontierNaive(pool, scoredStates, benefitStats);
  }
  const stateIndexes = canonicalizeStateVectors(pool, scoredStates.map(item => item.stateIndex), benefitStats);
  if (stateIndexes.length < smallBucketSkylineThreshold) {
    return buildParetoFrontierNaive(pool, stateIndexes.map(stateIndex => ({ stateIndex, score: 0 })), benefitStats);
  }
  const effectiveStats = getEffectiveBenefitStats(pool, stateIndexes, benefitStats);
  if (effectiveStats.length === 0) return stateIndexes;
  const points = stateIndexes.map(stateIndex => ({
    stateIndex,
    values: effectiveStats.map(stat => pool.statsWithoutFood[stateIndex][stat]),
  }));
  if (effectiveStats.length === 1) return buildOneDimensionalSkyline(points);
  return buildIndexedSkyline(points);
}

function buildParetoFrontierNaive(pool: StatePool, scoredStates: ScoredState[], benefitStats: number[]): number[] {
  const frontier: number[] = [];
  for (const { stateIndex } of scoredStates) {
    if (frontier.some(otherIndex => dominatesState(pool, otherIndex, stateIndex, benefitStats))) continue;
    for (let i = frontier.length - 1; i >= 0; i--) {
      if (dominatesState(pool, stateIndex, frontier[i], benefitStats)) {
        frontier.splice(i, 1);
      }
    }
    frontier.push(stateIndex);
  }
  return frontier;
}

function canonicalizeStateVectors(pool: StatePool, states: number[], benefitStats: number[]): number[] {
  const bestByVector = new Map<string, number>();
  for (const stateIndex of states) {
    const key = benefitStats.map(stat => pool.statsWithoutFood[stateIndex][stat]).join('|');
    const existing = bestByVector.get(key);
    if (existing === undefined || compareEquivalentStates(pool, stateIndex, existing) < 0) {
      bestByVector.set(key, stateIndex);
    }
  }
  return Array.from(bestByVector.values());
}

function compareEquivalentStates(pool: StatePool, a: number, b: number): number {
  if (pool.changeCount[a] !== pool.changeCount[b]) return pool.changeCount[a] - pool.changeCount[b];
  if (pool.materiaCount[a] !== pool.materiaCount[b]) return pool.materiaCount[a] - pool.materiaCount[b];
  const aLevel = pool.equippedLevelWeight[a] === 0 ? 0 : pool.equippedLevelTotal[a] / pool.equippedLevelWeight[a];
  const bLevel = pool.equippedLevelWeight[b] === 0 ? 0 : pool.equippedLevelTotal[b] / pool.equippedLevelWeight[b];
  return bLevel - aLevel;
}

function getEffectiveBenefitStats(pool: StatePool, states: number[], benefitStats: number[]): number[] {
  return benefitStats.filter(stat => {
    const first = pool.statsWithoutFood[states[0]][stat];
    return states.some(stateIndex => pool.statsWithoutFood[stateIndex][stat] !== first);
  });
}

function buildOneDimensionalSkyline(points: SkylinePoint[]): number[] {
  let best = -Infinity;
  for (const point of points) {
    best = Math.max(best, point.values[0]);
  }
  return points
    .filter(point => point.values[0] === best)
    .map(point => point.stateIndex);
}

function buildIndexedSkyline(points: SkylinePoint[]): number[] {
  const sorted = points.slice().sort(compareSkylinePoints);
  if (sorted[0].values.length === 2) return buildTwoDimensionalSkyline(sorted);
  const rankMaps = buildRankMaps(sorted);
  const tree = createSparseFenwick(rankMaps.map(rankMap => rankMap.size));
  const ret: number[] = [];
  for (const point of sorted) {
    const rankIndexes = point.values.slice(1, -1)
      .map((value, i) => rankMaps[i].get(value)!);
    const lastValue = point.values[point.values.length - 1];
    if (sparseFenwickQuery(tree, rankIndexes) >= lastValue) continue;
    ret.push(point.stateIndex);
    sparseFenwickUpdate(tree, rankIndexes, lastValue);
  }
  return ret;
}

function compareSkylinePoints(a: SkylinePoint, b: SkylinePoint): number {
  for (let i = 0; i < a.values.length; i++) {
    const diff = b.values[i] - a.values[i];
    if (diff !== 0) return diff;
  }
  return a.stateIndex - b.stateIndex;
}

function buildTwoDimensionalSkyline(points: SkylinePoint[]): number[] {
  const ret: number[] = [];
  let bestSecond = -Infinity;
  for (const point of points) {
    const second = point.values[1];
    if (bestSecond >= second) continue;
    ret.push(point.stateIndex);
    bestSecond = second;
  }
  return ret;
}

function buildRankMaps(points: SkylinePoint[]): Map<number, number>[] {
  const dimensionCount = points[0].values.length;
  const ret: Map<number, number>[] = [];
  for (let dim = 1; dim < dimensionCount - 1; dim++) {
    const values = Array.from(new Set(points.map(point => point.values[dim]))).sort((a, b) => b - a);
    ret.push(new Map(values.map((value, i) => [value, i + 1])));
  }
  return ret;
}

function createSparseFenwick(sizes: number[]) {
  return {
    sizes,
    root: new Map<number, number | SparseFenwickNode>(),
  };
}

function sparseFenwickUpdate(
  tree: { sizes: number[], root: SparseFenwickNode },
  indexes: number[],
  value: number,
): void {
  updateSparseFenwickNode(tree.root, tree.sizes, indexes, 0, value);
}

function updateSparseFenwickNode(
  node: SparseFenwickNode,
  sizes: number[],
  indexes: number[],
  dim: number,
  value: number,
): void {
  for (let i = indexes[dim]; i <= sizes[dim]; i += i & -i) {
    if (dim === indexes.length - 1) {
      node.set(i, Math.max((node.get(i) as number | undefined) ?? -Infinity, value));
    } else {
      let child = node.get(i) as SparseFenwickNode | undefined;
      if (child === undefined) {
        child = new Map<number, number | SparseFenwickNode>();
        node.set(i, child);
      }
      updateSparseFenwickNode(child, sizes, indexes, dim + 1, value);
    }
  }
}

function sparseFenwickQuery(tree: { sizes: number[], root: SparseFenwickNode }, indexes: number[]): number {
  return querySparseFenwickNode(tree.root, indexes, 0);
}

function querySparseFenwickNode(node: SparseFenwickNode, indexes: number[], dim: number): number {
  let ret = -Infinity;
  for (let i = indexes[dim]; i > 0; i -= i & -i) {
    const value = node.get(i);
    if (value === undefined) continue;
    if (dim === indexes.length - 1) {
      ret = Math.max(ret, value as number);
    } else {
      ret = Math.max(ret, querySparseFenwickNode(value as SparseFenwickNode, indexes, dim + 1));
    }
  }
  return ret;
}

function scoreState(
  pool: StatePool,
  stateIndex: number,
  input: GearOptimizationInput,
  schema: G.JobSchema,
): number {
  const cached = pool.score[stateIndex];
  if (!Number.isNaN(cached)) return cached;
  const score = scoreStats(input, schema, arrayToStats(pool.statsWithoutFood[stateIndex]));
  pool.score[stateIndex] = score;
  return score;
}

function scoreStats(
  input: GearOptimizationInput,
  schema: G.JobSchema,
  stats: G.Stats,
): number {
  const effects = calculateCombatEffects({
    job: input.job,
    jobLevel: input.jobLevel,
    schema,
    stats,
    baseStats: input.baseStats,
  });
  return effects?.damage ?? 0;
}

function dominates(a: G.Stats, b: G.Stats, stats: G.Stat[]): boolean {
  let better = false;
  for (const stat of stats) {
    const av = a[stat] ?? 0;
    const bv = b[stat] ?? 0;
    if (av < bv) return false;
    if (av > bv) better = true;
  }
  return better;
}

function dominatesState(pool: StatePool, a: number, b: number, stats: number[]): boolean {
  const aStats = pool.statsWithoutFood[a];
  const bStats = pool.statsWithoutFood[b];
  let better = false;
  for (const stat of stats) {
    if (aStats[stat] < bStats[stat]) return false;
    if (aStats[stat] > bStats[stat]) better = true;
  }
  if (better) return true;
  return pool.changeCount[a] <= pool.changeCount[b] &&
    pool.materiaCount[a] <= pool.materiaCount[b] &&
    (pool.changeCount[a] < pool.changeCount[b] || pool.materiaCount[a] < pool.materiaCount[b]);
}

function finalizeResults(
  input: GearOptimizationInput,
  schema: G.JobSchema,
  pool: StatePool,
  states: number[],
  localPlans: LocalPlan[],
  config: GearOptimizationConfig,
  speedStat: G.Stat,
): GearOptimizationResult[] {
  const ret: GearOptimizationResult[] = [];
  for (const stateIndex of states) {
    const statsWithoutFood = arrayToStats(pool.statsWithoutFood[stateIndex]);
    for (const food of input.foodCandidates) {
      const stats = applyFood(statsWithoutFood, food);
      const effects = calculateCombatEffects({
        job: input.job,
        jobLevel: input.jobLevel,
        schema,
        stats,
        baseStats: input.baseStats,
      });
      if (effects === undefined) continue;
      if (!matchesGcd(effects.gcd, config)) continue;
      if (!matchesTenMitigation(effects, config)) continue;
      const path = buildResultPath(pool, localPlans, stateIndex);
      ret.push({
        objectiveScore: effects.damage,
        damage: effects.damage,
        tenMitigation: effects.tenMitigation,
        gcd: effects.gcd,
        equippedLevel: floor(pool.equippedLevelTotal[stateIndex] / pool.equippedLevelWeight[stateIndex]),
        stats,
        effects,
        selectedGears: path.selectedGears,
        foodId: food.id,
        materiaAssignments: path.materiaAssignments,
        changeCount: pool.changeCount[stateIndex] + (input.hasEquippedFood ? 0 : 1),
        materiaCount: pool.materiaCount[stateIndex],
      });
    }
  }
  return dedupeResults(ret, speedStat);
}

function matchesTenMitigation(effects: CombatEffects, config: GearOptimizationConfig): boolean {
  return config.minTenMitigation === undefined || effects.tenMitigation >= config.minTenMitigation;
}

function buildResultPath(pool: StatePool, localPlans: LocalPlan[], stateIndex: number): {
  selectedGears: [number, G.GearId][],
  materiaAssignments: [G.GearId, MateriaAssignment[]][],
} {
  const selectedGears: [number, G.GearId][] = [];
  const materiaAssignments: [G.GearId, MateriaAssignment[]][] = [];
  const planIndexes: number[] = [];
  for (let index = stateIndex; index >= 0; index = pool.prevStateIndex[index]) {
    const planIndex = pool.planIndex[index];
    if (planIndex >= 0) planIndexes.push(planIndex);
  }
  for (let i = planIndexes.length - 1; i >= 0; i--) {
    const plan = localPlans[planIndexes[i]];
    for (const selectedGear of plan.selectedGears) {
      selectedGears.push(selectedGear);
    }
    for (const materiaAssignment of plan.materiaAssignmentsByGear) {
      materiaAssignments.push(materiaAssignment);
    }
  }
  return { selectedGears, materiaAssignments };
}

function applyFood(statsWithoutFood: G.Stats, food: OptimizerFoodInput): G.Stats {
  const stats = { ...statsWithoutFood };
  for (const stat of Object.keys(food.stats) as G.Stat[]) {
    if (stat in food.statRates) {
      stats[stat] = (stats[stat] ?? 0) +
        Math.min(food.stats[stat]!, floor((statsWithoutFood[stat] ?? 0) * food.statRates[stat]! / 100));
    } else {
      stats[stat] = (stats[stat] ?? 0) + food.stats[stat]!;
    }
  }
  return stats;
}

function applyFoodStat(valueWithoutFood: number, food: OptimizerFoodInput, stat: G.Stat): number {
  const foodValue = food.stats[stat];
  if (foodValue === undefined) return valueWithoutFood;
  if (stat in food.statRates) {
    return valueWithoutFood + Math.min(foodValue, floor(valueWithoutFood * food.statRates[stat]! / 100));
  }
  return valueWithoutFood + foodValue;
}

function matchesGcd(gcd: number, config: GearOptimizationConfig): boolean {
  if (config.targetGcd !== undefined) return gcd === config.targetGcd;
  if (config.minGcd !== undefined && gcd < config.minGcd) return false;
  if (config.maxGcd !== undefined && gcd > config.maxGcd) return false;
  return true;
}

function compareResults(a: GearOptimizationResult, b: GearOptimizationResult, config: GearOptimizationConfig): number {
  const scoreDiff = b.objectiveScore - a.objectiveScore;
  if (Math.abs(scoreDiff) > objectiveEpsilon) return scoreDiff;
  const damageDiff = b.damage - a.damage;
  if (Math.abs(damageDiff) > objectiveEpsilon) return damageDiff;
  const tenMitigationDiff = b.tenMitigation - a.tenMitigation;
  if (Math.abs(tenMitigationDiff) > objectiveEpsilon) return tenMitigationDiff;
  if (config.targetGcd !== undefined) {
    const gcdDiff = Math.abs(a.gcd - config.targetGcd) - Math.abs(b.gcd - config.targetGcd);
    if (gcdDiff !== 0) return gcdDiff;
  }
  if (a.changeCount !== b.changeCount) return a.changeCount - b.changeCount;
  if (a.materiaCount !== b.materiaCount) return a.materiaCount - b.materiaCount;
  return b.equippedLevel - a.equippedLevel;
}

function dedupeResults(results: GearOptimizationResult[], speedStat: G.Stat): GearOptimizationResult[] {
  const seen = new Set<string>();
  const ret: GearOptimizationResult[] = [];
  for (const result of results) {
    const key = [
      result.damage.toFixed(9),
      result.tenMitigation.toFixed(9),
      result.gcd.toFixed(2),
      result.stats[speedStat],
      result.selectedGears.map(([slot, id]) => `${slot}:${id}`).join(','),
      result.foodId,
    ].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    ret.push(result);
  }
  return ret;
}

function getStatIndex(stat: G.Stat): number {
  const index = optimizerStatIndex.get(stat);
  if (index === undefined) throw new Error(`未知属性：${stat}`);
  return index;
}

function statsToArray(stats: G.Stats): Float64Array {
  const ret = new Float64Array(optimizerStats.length);
  for (const [ stat, value ] of Object.entries(stats) as G.StatPairs) {
    const index = optimizerStatIndex.get(stat);
    if (index !== undefined) ret[index] = value;
  }
  return ret;
}

function statValuesToEntries(stats: Float64Array): [number, number][] {
  const ret: [number, number][] = [];
  for (let i = 0; i < stats.length; i++) {
    if (stats[i] !== 0) ret.push([i, stats[i]]);
  }
  return ret;
}

function arrayToStats(values: Float64Array): G.Stats {
  const ret: G.Stats = {};
  for (let i = 0; i < values.length; i++) {
    if (values[i] !== 0) ret[optimizerStats[i]] = values[i];
  }
  return ret;
}
