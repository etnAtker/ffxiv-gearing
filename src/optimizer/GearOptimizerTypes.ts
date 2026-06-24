import * as G from '../game';
import type { CombatEffects } from '../stores/effects';

export interface GearOptimizationConfig {
  minGcd?: number,
  maxGcd?: number,
  targetGcd?: number,
  pruneRatio?: number,
  minTenMitigation?: number,
  resultLimit: number,
}

export interface MateriaAssignment {
  index: number,
  stat: G.Stat,
  grade: G.MateriaGrade,
}

export interface GearOptimizationResult {
  objectiveScore: number,
  damage: number,
  tenMitigation: number,
  gcd: number,
  equippedLevel: number,
  stats: G.Stats,
  effects: CombatEffects,
  selectedGears: [number, G.GearId][],
  foodId?: G.GearId,
  materiaAssignments: [G.GearId, MateriaAssignment[]][],
  changeCount: number,
  materiaCount: number,
}

export interface GearOptimizationReport {
  results: GearOptimizationResult[],
  error?: string,
  candidateCount: number,
  stateCount: number,
}

export interface GearOptimizationProgress {
  phase: string,
  current: number,
  total: number,
  states?: number,
}

export type GearOptimizationStatus =
  | { status: 'idle' }
  | { status: 'running', progress: GearOptimizationProgress }
  | { status: 'done', report: GearOptimizationReport }
  | { status: 'error', error: string }
  | { status: 'cancelled' };

export interface OptimizerMateriaSlotInput {
  index: number,
  fixedStat?: G.Stat,
  fixedGrade?: G.MateriaGrade,
  optionStats: G.Stat[],
  optionGrade?: G.MateriaGrade,
}

export interface OptimizerGearInput {
  id: G.GearId,
  name: string,
  level: number,
  slot: number,
  slotName: string,
  slotWeight: number,
  fixed: boolean,
  bareStats: G.Stats,
  caps: G.Stats,
  syncedLevel?: number,
  syncedCaps?: G.Stats,
  occultStats?: G.Stats,
  materiaSlot: number,
  materias: OptimizerMateriaSlotInput[],
}

export interface OptimizerFoodInput {
  id: G.GearId,
  stats: G.Stats,
  statRates: G.Stats,
  fixed: boolean,
}

export interface GearOptimizationInput {
  job: G.Job,
  jobLevel: G.JobLevel,
  baseStats: G.Stats,
  candidateSlots: { slot: number, name: string, plans: OptimizerGearInput[] }[],
  foodCandidates: OptimizerFoodInput[],
  hasEquippedFood: boolean,
}

export interface GearOptimizationWorkerRequest {
  type: 'optimize',
  input: GearOptimizationInput,
  config: GearOptimizationConfig,
}

export type GearOptimizationWorkerResponse =
  | { type: 'progress', progress: GearOptimizationProgress }
  | { type: 'result', report: GearOptimizationReport }
  | { type: 'error', error: string };
