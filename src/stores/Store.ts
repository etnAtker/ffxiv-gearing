import * as mobx from 'mobx';
import * as mst from 'mobx-state-tree';
import * as G from '../game';
import * as share from '../share';
import { runGearOptimizationInWorker, type GearOptimizationRunner } from '../optimizer/GearOptimizerRunner';
import type {
  GearOptimizationConfig, GearOptimizationInput, GearOptimizationProgress,
  GearOptimizationReport, GearOptimizationResult, GearOptimizationStatus, OptimizerFoodInput,
  OptimizerGearInput
} from '../optimizer/GearOptimizerTypes';
import { calculateCombatEffects } from './effects';
import {
  floor, ceil, Setting, Promotion, GearUnion, GearUnionReference,
  gearDataOrdered, gearDataLoading, loadGearDataOfGearId, loadGearDataOfLevelRange
} from '.';
import type { IGear, IFood, IGearUnion, IMateria } from '.';

const clanStorageKey = 'ffxiv-gearing.dt.clan';
const tiersShownStorageKey = 'ffxiv-gearing.dt.tiers-shown';

export type Mode = 'edit' | 'view';

export type FilterFocus = 'no' | 'melded' | 'comparable';

export const Store = mst.types
  .model('Store', {
    mode: mst.types.optional(mst.types.string as mst.ISimpleType<Mode>, 'edit'),
    job: mst.types.maybe(mst.types.string as mst.ISimpleType<G.Job>),
    jobLevel: mst.types.optional(mst.types.number as mst.ISimpleType<G.JobLevel>, 100),
    levelRangeText: mst.types.optional(mst.types.string, ''),
    syncLevel: mst.types.maybe(mst.types.number),
    filterFocus: mst.types.optional(mst.types.string as mst.ISimpleType<FilterFocus>, 'no'),
    showAllMaterias: mst.types.optional(mst.types.boolean, false),
    showAllFoods: mst.types.optional(mst.types.boolean, false),
    showAllPotions: mst.types.optional(mst.types.boolean, false),
    duplicateToolMateria: mst.types.optional(mst.types.boolean, true),
    gears: mst.types.map(GearUnion),
    equippedGears: mst.types.map(GearUnionReference),
  })
  .volatile(() => ({
    setting: Setting.create(),
    promotion: Promotion.create(),
    clan: Number(localStorage.getItem(clanStorageKey)) || 0,
    tiersShown: localStorage.getItem(tiersShownStorageKey) === 'true',
    materiaOverallActiveTab: 0,
    autoSelectScheduled: false,
    pendingLevelRangeText: undefined as string | undefined,
    excludedGearIds: mobx.observable.set<G.GearId>(),
    gearOptimizationStatus: { status: 'idle' } as GearOptimizationStatus,
    gearOptimizationRunner: undefined as GearOptimizationRunner | undefined,
  }))
  .views(self => ({
    get filteredIds(): G.GearId[] {
      console.debug('filteredIds');
      if (self.job === undefined) return [];
      if (self.mode === 'view') {
        return Array.from(self.gears.keys(), id => Number(id) as G.GearId)
          .filter(id => !self.excludedGearIds.has(Math.abs(id) as G.GearId));
      }

      const levelRanges = parseLevelRanges(self.levelRangeText);
      const unobservableEquippedGears = mobx.untracked(() => self.equippedGears.toJSON());
      const ret: G.GearId[] = [];

      for (const gear of gearDataOrdered.get()) {
        if (self.excludedGearIds.has(gear.id)) continue;

        const { job } = self;

        const levelMatched = levelRanges !== undefined &&
          levelRanges.some(([min, max]) => gear.level >= min && gear.level <= max);

        if (
          G.jobCategories[gear.jobCategory][job!] &&
          (gear.slot === -1 ? (self.showAllFoods || 'best' in gear) :  // Foods
            gear.slot === -2 ? (self.showAllPotions || 'best' in gear) :  // Potions
              gear.slot === 17 || (gear.slot === 2 && job === 'FSH') ||  // Soul crystal and spearfishing gig
              (levelMatched &&
                !(gear.obsolete && this.setting.hideObsoleteGears))
          )
        ) {
          ret.push(gear.id);
          if (gear.slot === 12) {
            ret.push(-gear.id as G.GearId);
          }
        } else {
          if (unobservableEquippedGears[gear.slot] === gear.id) {
            ret.push(gear.id);
          }
          if (unobservableEquippedGears[-gear.slot] === -gear.id) {
            ret.push(-gear.id as G.GearId);
          }
        }
      }
      return ret;
    },
  }))
  .views(self => ({
    get loadingStatus() {
      return gearDataLoading.get()
        ? self.pendingLevelRangeText !== undefined
          ? 'appending'
          : 'loading'
        : 'ready';
    },
    get isViewing(): boolean {
      return self.mode === 'view';
    },
    get schema(): G.JobSchema {
      if (self.job === undefined) throw new ReferenceError();
      return G.jobSchemas[self.job];
    },
    get groupedGears(): { [index: number]: IGearUnion[] } {
      console.debug('groupedGears');
      const ret: { [index: number]: IGearUnion[] } = {};
      for (const gearId of self.filteredIds) {
        const gear = self.gears.get(gearId.toString())!;
        if (!gear.isFood && !gear.isMelded) {
          if (self.filterFocus === 'melded' && !gear.isEquipped) continue;
          if (self.filterFocus === 'comparable') continue;
        }
        if (!(gear.slot in ret)) {
          ret[gear.slot] = [];
        }
        ret[gear.slot].push(gear);
      }
      return ret;
    },
    get baseStats(): G.Stats {
      if (self.job === undefined) return {};
      const levelModifier = G.jobLevelModifiers[self.jobLevel];
      const stats: G.Stats = { PDMG: 0, MDMG: 0, DLY: 0 };
      for (const stat of this.schema.stats as G.Stat[]) {
        const baseStat = G.baseStats[stat] ?? 0;
        if (typeof baseStat === 'number') {
          stats[stat] = baseStat;
        } else {
          stats[stat] = floor(levelModifier[baseStat] * (this.schema.statModifiers[stat] ?? 100) / 100) +
            (G.clanStats[stat]?.[self.clan] ?? 0);
        }
      }
      return stats;
    },
    get equippedStatsWithoutFood(): G.Stats {
      if (self.job === undefined) return {};
      const stats: G.Stats = { ...this.baseStats };
      for (const gear of self.equippedGears.values()) {
        if (gear === undefined) continue;
        if (!gear.isFood) {
          for (const stat of Object.keys(gear.stats) as G.Stat[]) {
            stats[stat] = stats[stat]! + gear.stats[stat]!;
          }
        }
      }
      return stats;
    },
    get equippedStats(): G.Stats {
      console.debug('equippedStats');
      if (self.job === undefined) return {};
      const stats = { ...this.equippedStatsWithoutFood };
      for (const slot of ['-1', '-2']) {
        const equippedFood = self.equippedGears.get(slot) as IFood;
        if (equippedFood === undefined) continue;
        for (const stat of Object.keys(this.equippedStatsWithoutFood) as G.Stat[]) {
          stats[stat] += equippedFood.effectiveStats[stat] ?? 0;
        }
      }
      return stats;
    },
    get equippedLevel(): number {
      let level = 0;
      let weight = 0;
      for (const slot of this.schema.slots) {
        level += (self.equippedGears.get(slot.slot)?.level ?? 0) * (slot.levelWeight ?? 1);
        weight += (slot.levelWeight ?? 1);
      }
      return floor(level / weight);
    },
    get isMateriaNamesSameWidth(): boolean {
      let lastWidth = -1;
      for (const gear of self.equippedGears.values()) {
        if (gear === undefined || gear.isFood) continue;
        for (const { name } of gear.materias) {
          if (name.length === 0) continue;
          let width = 0;
          for (let i = 0; i < name.length; i++) {
            width += name.charCodeAt(i) < 0x100 ? 1 : 2;
          }
          if (lastWidth !== -1 && width !== lastWidth) return false;
          lastWidth = width;
        }
      }
      return true;
    },
    get materiaConsumption() {
      const consumption: { [index in G.Stat]?: { [index in G.MateriaGrade]?:
        { safe: number, expectation: number, confidence90: number, confidence99: number, rates: number[] } } } = {};
      for (const gear of self.equippedGears.values()) {
        if (gear === undefined || gear.isFood) continue;
        const duplicates = self.duplicateToolMateria &&
          (gear.slot === 1 || gear.slot === 2) && this.schema.toolMateriaDuplicates || 1;
        for (const materia of gear.materias) {
          if (materia.stat === undefined) continue;
          const consumptionStat = consumption[materia.stat] ??= {};
          const consumptionItem = consumptionStat[materia.grade!] ??=
            { safe: 0, expectation: 0, confidence90: 0, confidence99: 0, rates: [] };
          for (let i = 0; i < duplicates; i++) {
            if (materia.successRate === 100) {
              consumptionItem.safe += 1;
            } else {
              consumptionItem.expectation += 100 / materia.successRate!;
              consumptionItem.rates.push(materia.successRate! / 100);
            }
          }
        }
      }
      let advancedItemCount = 0;
      for (const consumptionOfStat of Object.values(consumption)) {
        for (const consumptionItem of Object.values(consumptionOfStat!)) {
          if (consumptionItem!.rates.length > 0) {
            advancedItemCount++;
          }
        }
      }
      const p90 = .90 ** (1 / advancedItemCount);
      const p99 = .99 ** (1 / advancedItemCount);
      const thresholds90: { pBelow: number, pAbove: number, increase: () => void }[] = [];
      const thresholds99: { pBelow: number, pAbove: number, increase: () => void }[] = [];
      for (const consumptionOfStat of Object.values(consumption)) {
        for (const consumptionItem of Object.values(consumptionOfStat!)) {
          consumptionItem!.expectation = consumptionItem!.safe + Math.round(consumptionItem!.expectation);
          const p = consumptionItem!.rates;
          if (p.length === 0) {
            consumptionItem!.confidence90 = consumptionItem!.confidence99 = consumptionItem!.safe;
            continue;
          }
          const pp: number[][] = p.map(pi => [1, 1 - pi]);
          const ps: Float64Array[] = [];
          let n = 1;
          let n90 = 0;
          while (true) {
            for (let i = 0; i < p.length; i++) {
              pp[i][n] = pp[i][n - 1] * pp[i][1];
            }
            ps[n] = new Float64Array(p.length);
            ps[n][p.length - 1] = 1 - pp[p.length - 1][n];
            for (let i = p.length - 2; i >= 0; i--) {
              if (p.length - i > n) break;
              ps[n][i] = 0;
              for (let j = 1; j <= n - (p.length - i) + 1; j++) {
                ps[n][i] += pp[i][j - 1] * p[i] * ps[n - j][i + 1];
              }
            }
            if (ps[n][0] > p90 && n90 === 0) n90 = n;
            if (ps[n][0] > p99) break;
            n++;
          }
          consumptionItem!.confidence90 = consumptionItem!.safe + n90 - 1;
          consumptionItem!.confidence99 = consumptionItem!.safe + n - 1;
          thresholds90.push({
            pBelow: ps[n90 - 1][0],
            pAbove: ps[n90][0],
            increase: () => consumptionItem!.confidence90++,
          });
          thresholds99.push({
            pBelow: ps[n - 1][0],
            pAbove: ps[n][0],
            increase: () => consumptionItem!.confidence99++,
          });
        }
      }
      for (const [threshold, pTarget] of [[thresholds90, .90], [thresholds99, .99]] as const) {
        threshold.sort((a, b) => a.pBelow - b.pBelow);
        let pOverall = 1;
        for (const entry of threshold) {
          pOverall *= entry.pBelow;
        }
        for (const entry of threshold) {
          entry.increase();
          pOverall = pOverall / entry.pBelow * entry.pAbove;
          if (pOverall > pTarget) break;
        }
      }
      return consumption;
    },
    get syncLevelText(): number | string | undefined {
      if (self.syncLevel !== undefined) {
        return self.syncLevel.toString();
      }
      if (self.jobLevel !== this.schema.jobLevel) {
        return self.jobLevel + '级';
      }
    },
    get clanText(): string {
      return `${G.races[floor(self.clan / 2)]} - ${G.clans[self.clan]}`;
    },
  }))
  .views(self => ({
    get equippedStatsText(): string {
      let stats = self.schema.stats;
      if (stats[0] === 'STR' || stats[0] === 'DEX') {
        stats = stats.concat('PDMG', 'DLY');
      }
      if (stats[0] === 'INT' || stats[0] === 'MND') {
        stats = stats.concat('MDMG');
      }
      return stats.map(stat => {
        const value = self.equippedStats[stat]!;
        return `${G.statNames[stat]} ${stat !== 'DLY' ? value : (value / 1000).toFixed(2)}`;
      }).join('\n');
    },
    get equippedEffects() {
      console.debug('equippedEffects');
      if (self.job === undefined) return;
      return calculateCombatEffects({
        job: self.job,
        jobLevel: self.jobLevel,
        schema: self.schema,
        stats: self.equippedStats,
        baseStats: self.baseStats,
      });
    },
    get equippedTiers(): { [index in G.Stat]?: { prev: number, next: number } } | undefined {
      const { statModifiers } = self.schema;
      if (statModifiers === undefined) return;
      const { main, sub, div, det, detTrunc } = G.jobLevelModifiers[self.jobLevel];
      const { CRT, DET, DHT, TEN, SKS, SPS, PIE } = self.equippedStats;
      function calcTier(value: number, multiplier: number) {
        if (Number.isNaN(value)) return undefined;
        const quotient = floor(value / multiplier);
        const prev = ceil(quotient * multiplier) - 1 - value;
        const next = ceil((quotient + 1) * multiplier) - value;
        return { prev, next };
      }
      function calcGcdTier(value: number, multiplier: number, modifier: number) {
        if (Number.isNaN(value)) return undefined;
        const gcdc = floor(floor((1000 - floor(value / multiplier)) * 2.5) * modifier);
        const prev = ceil((floor(1000 - ceil((gcdc + 1) / modifier) / 2.5) + 1) * multiplier) - 1 - value;
        const next = ceil((floor(1000 - ceil(gcdc / modifier) / 2.5) + 1) * multiplier) - value;
        return { prev, next };
      }
      return {
        CRT: calcTier(CRT! - sub, div / 200),
        DET: calcTier(DET! - main, det / 140 * detTrunc),
        DHT: calcTier(DHT! - sub, div / 550),
        TEN: calcTier(TEN! - sub, div / 112),
        SKS: calcGcdTier(SKS! - sub, div / 130, (statModifiers.gcd ?? 100) / 1000),
        SPS: calcGcdTier(SPS! - sub, div / 130, (statModifiers.gcd ?? 100) / 1000),
        PIE: calcTier(PIE! - main, div / 150),
      };
    },
    get materiaDetDhtOptimized() {
      console.debug('materiaDetDhtOptimized');
      type Pair = number;
      type Meld = [number, number];
      type OriginalMelds = { DET: Meld, DHT: Meld, all: Meld };
      type Route = Pair[];

      const pack = (stats: G.Stats): Pair => ((stats.DET ?? 0) << 16) | (stats.DHT ?? 0);
      const unpack = (pair: Pair) => ([pair >> 16, pair & ~(-1 << 16)]);
      const mapPush = <TKey, TItem>(map: Map<TKey, TItem[]>, key: TKey, item: TItem) => {
        const items = map.get(key) ?? [];
        items.push(item);
        map.set(key, items);
      };

      const gearOriginalMelds = new Map<G.GearId, OriginalMelds>();
      let food: IFood | undefined;
      let fixedPair = pack(self.baseStats);
      const freeGears: IGear[] = [];
      const freeMajorSlots: IMateria[] = [];
      const freeMinorSlots: IMateria[] = [];
      const freePossiblePairMelds = new Map<Pair, Meld[]>();
      const crucialGears: IGear[] = [];
      const crucialGearPossiblePairMelds: Map<Pair, Meld[]>[] = [];

      mobx.runInAction(() => {
        const replica = Store.create(mst.getSnapshot(self));
        replica.unprotect();

        for (const gear of replica.equippedGears.values()) {
          if (gear === undefined) continue;
          if (gear.isFood) {
            food = gear;
            continue;
          }

          const slots = gear.materias.filter(m => m.stat === 'DET' || m.stat === 'DHT' || m.stat === undefined);
          const originalMelds: OriginalMelds = { DET: [0, 0], DHT: [0, 0], all: [0, 0] };
          for (const materia of slots) {
            materia.grade = materia.meldableGrades[0];
            const meldType = materia.canRestricted ? 0 : 1;
            if (materia.stat === 'DET') originalMelds['DET'][meldType]++;
            if (materia.stat === 'DHT') originalMelds['DHT'][meldType]++;
            originalMelds['all'][meldType]++;
          }
          gearOriginalMelds.set(gear.id, originalMelds);

          for (const materia of slots) materia.stat = 'DET';
          const pairAllDet = pack(gear.stats);
          const overcapAllDet = gear.currentMeldableStats.DET! < 0;
          for (const materia of slots) materia.stat = 'DHT';
          const pairAllDht = pack(gear.stats);
          const overcapAllDht = gear.currentMeldableStats.DHT! < 0;

          if (pairAllDet === pairAllDht) {
            fixedPair += pairAllDet;
          } else if (!overcapAllDet && !overcapAllDht && (freeGears.length === 0 ||
            gear.materias[0].meldableGrades[0] === freeGears[0].materias[0].meldableGrades[0])) {
            freeGears.push(gear);
            for (const materia of slots) {
              (materia.canRestricted ? freeMajorSlots : freeMinorSlots).push(materia);
            }
          } else {
            crucialGears.push(gear);
            const majorSlots = slots.filter(m => m.canRestricted);
            const minorSlots = slots.filter(m => !m.canRestricted);
            const pairMelds = new Map<Pair, Meld[]>();

            for (let majorDetAmount = 0; majorDetAmount <= majorSlots.length; majorDetAmount++) {
              if (majorDetAmount > 0) majorSlots[majorDetAmount - 1].stat = 'DET';
              for (const minorSlot of minorSlots) minorSlot.stat = 'DHT';

              for (let minorDetAmount = 0; minorDetAmount <= minorSlots.length; minorDetAmount++) {
                if (minorDetAmount > 0) minorSlots[minorDetAmount - 1].stat = 'DET';
                const pair = pack(gear.stats);
                mapPush(pairMelds, pair, [majorDetAmount, minorDetAmount]);
              }
            }

            for (const pair of pairMelds.keys()) {
              const [DET, DHT] = unpack(pair);
              for (const pair2 of pairMelds.keys()) {
                if (pair === pair2) continue;
                const [DET2, DHT2] = unpack(pair2);
                if (DET <= DET2 && DHT <= DHT2) {
                  pairMelds.delete(pair);
                  break;
                }
              }
            }

            crucialGearPossiblePairMelds.push(pairMelds);
          }
        }

        for (let majorDetAmount = 0; majorDetAmount <= freeMajorSlots.length; majorDetAmount++) {
          if (majorDetAmount > 0) freeMajorSlots[majorDetAmount - 1].stat = 'DET';
          for (const minorSlot of freeMinorSlots) minorSlot.stat = 'DHT';

          for (let minorDetAmount = 0; minorDetAmount <= freeMinorSlots.length; minorDetAmount++) {
            if (minorDetAmount > 0) freeMinorSlots[minorDetAmount - 1].stat = 'DET';
            const pair = freeGears.reduce((sc, gear) => sc + pack(gear.stats), 0);
            mapPush(freePossiblePairMelds, pair, [majorDetAmount, minorDetAmount]);
          }
        }
      });

      const { main, sub, div, det, detTrunc } = G.jobLevelModifiers[self.jobLevel];
      const bluAetherialMimicry = self.job === 'BLU' ? 200 : 0;
      const foodDet = food?.stats?.['DET'] ?? 0;
      const foodDetRate = food?.statRates?.['DET'] ?? Infinity;
      const foodDht = food?.stats?.['DHT'] ?? 0;
      const foodDhtRate = food?.statRates?.['DHT'] ?? Infinity;

      let maxDamage = 0;
      let acceptableDamage = 0;
      const damagePossibleTotalPairs = new Map<number, Pair[]>();
      const totalPairPossibleRoutes = new Map<Pair, Route[]>();
      const combinedPossiblePairMelds = [freePossiblePairMelds].concat(crucialGearPossiblePairMelds);
      const route: Route = [];

      const search = (currentPair: Pair, gearIndex: number) => {
        if (gearIndex < combinedPossiblePairMelds.length) {
          for (const pair of combinedPossiblePairMelds[gearIndex].keys()) {
            route[gearIndex] = pair;
            search(currentPair + pair, gearIndex + 1);
          }
        } else {
          let [DET, DHT] = unpack(currentPair);
          DET += Math.min(foodDet, floor(DET * foodDetRate / 100));
          DHT += Math.min(foodDht, floor(DHT * foodDhtRate / 100));

          const detDamage = floor((140 * (DET - main) / det + 1000) / detTrunc) * detTrunc / 1000;
          const dhtChance = floor(550 * (DHT - sub) / div + bluAetherialMimicry) / 1000;
          const damage = detDamage * (0.25 * dhtChance + 1);

          if (damage > maxDamage) {
            maxDamage = damage;
            acceptableDamage = damage * 0.9997;
          }

          if (damage > acceptableDamage) {
            const totalPair = pack({ DET, DHT });
            mapPush(damagePossibleTotalPairs, damage, totalPair);
            mapPush(totalPairPossibleRoutes, totalPair, route.slice());
          }
        }
      };

      search(fixedPair, 0);

      for (const damage of damagePossibleTotalPairs.keys()) {
        if (damage <= acceptableDamage) {
          damagePossibleTotalPairs.delete(damage);
        }
      }

      const damages = new Float64Array(damagePossibleTotalPairs.keys()).sort().reverse();
      const goodTotalPairs: Pair[] = [];

      for (const damage of damages) {
        goodTotalPairs.push(...new Set(damagePossibleTotalPairs.get(damage)!).values());
      }

      const freeOriginalMelds: OriginalMelds = { DET: [0, 0], DHT: [0, 0], all: [0, 0] };
      const freeOriginalMaterias: IMateria[] = [];
      const freeGearMateriaPositions: Map<G.GearId, number[]> = new Map();

      for (const gear of freeGears) {
        for (const [stat, meld] of Object.entries(freeOriginalMelds)) {
          meld[0] += gearOriginalMelds.get(gear.id)![stat as keyof OriginalMelds][0];
          meld[1] += gearOriginalMelds.get(gear.id)![stat as keyof OriginalMelds][1];
        }
        freeGearMateriaPositions.set(gear.id, []);
      }

      for (let materiaIndex = 0; materiaIndex < 5; materiaIndex++) {
        for (const gear of freeGears) {
          const originalGead = self.gears.get(gear.id) as IGear;
          if (materiaIndex < originalGead.materias.length) {
            freeGearMateriaPositions.get(gear.id)![materiaIndex] = freeOriginalMaterias.length;
            freeOriginalMaterias.push(originalGead.materias[materiaIndex]);
          }
        }
      }

      const combinedPossiblePairDistance: Map<Pair, number>[] =
        Array.from({ length: combinedPossiblePairMelds.length }, () => new Map());
      const combinedPossiblePairMateriaStats: Map<Pair, G.Stat[]>[] =
        Array.from({ length: combinedPossiblePairMelds.length }, () => new Map());

      const solutions = goodTotalPairs.map(totalPair => {
        const routes = totalPairPossibleRoutes.get(totalPair)!;
        let bestDistance = Infinity;
        let bestRoute: Route | undefined;

        for (const route of routes) {
          let routeDistance = 0;

          for (let gearIndex = 0; gearIndex < route.length; gearIndex++) {
            const pair = route[gearIndex];
            let distance = combinedPossiblePairDistance[gearIndex].get(pair);

            if (distance === undefined) {
              distance = Infinity;
              let bestMateriaStats: G.Stat[] = [];
              const melds = combinedPossiblePairMelds[gearIndex].get(pair)!;

              for (const meld of melds) {
                let currentDistance = 0;
                const originalMaterias = gearIndex === 0
                  ? freeOriginalMaterias
                  : (self.gears.get(crucialGears[gearIndex - 1].id) as IGear).materias;
                const originalMelds = gearIndex === 0
                  ? freeOriginalMelds
                  : gearOriginalMelds.get(crucialGears[gearIndex - 1].id)!;
                const materiaStats = originalMaterias.map(m => m.stat);

                for (const meldType of [0, 1]) {
                  const statMeld = {
                    DET: meld[meldType],
                    DHT: originalMelds['all'][meldType] - meld[meldType],
                  };

                  for (const stat of ['DET', 'DHT'] as const) {
                    let retrieveAmount = originalMelds[stat][meldType] - statMeld[stat];
                    let materiaIndex = originalMaterias.length - 1;

                    while (retrieveAmount > 0) {
                      const materia = originalMaterias[materiaIndex];

                      if (materia.stat === stat && (materia.canRestricted === (meldType === 0))) {
                        currentDistance += 1000 + materia.gear.materias.length - materia.index;
                        materiaStats[materiaIndex] = undefined;
                        retrieveAmount--;
                      }

                      materiaIndex--;
                    }
                  }

                  for (const stat of ['DET', 'DHT'] as const) {
                    let meldAmount = statMeld[stat] - originalMelds[stat][meldType];
                    let materiaIndex = 0;

                    while (meldAmount > 0) {
                      if (materiaStats[materiaIndex] === undefined) {
                        materiaStats[materiaIndex] = stat;
                        meldAmount--;
                      }
                      materiaIndex++;
                    }
                  }
                }

                if (currentDistance < distance) {
                  distance = currentDistance;
                  bestMateriaStats = materiaStats.slice() as G.Stat[];
                }
              }

              combinedPossiblePairDistance[gearIndex].set(pair, distance);
              combinedPossiblePairMateriaStats[gearIndex].set(pair, bestMateriaStats);
            }

            routeDistance += distance;
          }

          if (routeDistance < bestDistance) {
            bestDistance = routeDistance;
            bestRoute = route;
          }
        }

        const gearMateriaStats: Map<G.GearId, G.Stat[]> = new Map();

        for (let gearIndex = 0; gearIndex < bestRoute!.length; gearIndex++) {
          const pair = bestRoute![gearIndex];
          const materiaStats = combinedPossiblePairMateriaStats[gearIndex].get(pair)!;

          if (gearIndex === 0) {
            for (const [gearId, positions] of freeGearMateriaPositions.entries()) {
              gearMateriaStats.set(gearId, positions.map(p => materiaStats[p]));
            }
          } else {
            gearMateriaStats.set(crucialGears[gearIndex - 1].id, materiaStats);
          }
        }

        const [DET, DHT] = unpack(totalPair);
        return { DET, DHT, gearMateriaStats };
      });

      return solutions;
    },
    get share(): string {
      if (self.job === undefined) return '';
      const gears: G.Gearset['gears'] = [];

      for (const slot of self.schema.slots) {
        const gear = self.equippedGears.get(slot.slot.toString());
        if (gear === undefined) continue;

        gears.push({
          id: gear.data.id,
          materias: gear.isFood || gear.syncedLevel !== undefined
            ? []
            : gear.materias.map(m => m.stat !== undefined ? [m.stat, m.grade!] : null),
          customStats: (gear as IGear).customStats?.toJSON(),
        });
      }

      return share.stringify({
        job: self.job,
        jobLevel: self.jobLevel,
        syncLevel: self.syncLevel,
        gears,
      });
    },
    get shareUrl(): string {
      return window.location.origin + window.location.pathname + '?' + this.share;
    },
    get garlandGroup(): string {
      if (self.job === undefined) return '';

      const parts = [self.schema.name, self.equippedLevel, ' ', (new Date()).toLocaleString(), '{'];

      for (const slot of self.schema.slots) {
        if (slot.slot === 17 || (slot.slot === 2 && self.job === 'FSH')) continue;

        const gear = self.equippedGears.get(slot.slot.toString());
        if (gear === undefined) continue;

        if (gear.data.id === parts.at(-2)) {
          parts.splice(-1, 0, '+2');
        } else {
          parts.push('item/');
          parts.push(gear.data.id);
          parts.push('|');
        }
      }

      parts[parts.length - 1] = '}';
      return `#group/${encodeURI(parts.join(''))}`;
    },
    get title(): string | undefined {
      const suffix = '最终幻想14配装器';
      if (self.job === undefined) return suffix;
      if (self.loadingStatus !== 'ready') return undefined;

      const glance = self.schema.mainStat !== undefined
        ? `il${self.equippedLevel}/${this.equippedEffects.gcd.toFixed(2)}s`
        : self.schema.stats.map(s => self.equippedStats[s]).join('/');

      return `${self.schema.name}(${glance}) - ${suffix}`;
    },
  }))
  .actions(self => ({
    createGears(): void {
      console.debug('createGears');
      for (const gearId of self.filteredIds) {
        if (!self.gears.has(gearId.toString())) {
          self.gears.put(GearUnion.create({ id: gearId }));
        }
      }
    },
    setMode(mode: Mode): void {
      self.mode = mode;
    },
    setJob(job: G.Job): void {
      self.pendingLevelRangeText = undefined;
      self.excludedGearIds.clear();

      const oldSchema = self.job && G.jobSchemas[self.job];
      const newSchema = G.jobSchemas[job];
      self.job = job;

      if (newSchema.jobLevel !== oldSchema?.jobLevel || !newSchema.levelSyncable) {
        self.jobLevel = newSchema.jobLevel;
        self.syncLevel = undefined;
      }

      if (newSchema.defaultItemLevel !== oldSchema?.defaultItemLevel) {
        self.levelRangeText = `${newSchema.defaultItemLevel[0]}-${newSchema.defaultItemLevel[1]}`;
      }

      for (const [key, gear] of self.equippedGears.entries()) {
        if (gear !== undefined && !gear.jobs[job]) {
          self.equippedGears.delete(key);
        }
      }

      self.autoSelectScheduled = newSchema.skeletonGears ?? false;
    },
    setLevelRangeText(value: string): boolean {
      const ranges = parseLevelRanges(value);
      if (ranges === undefined) return false;

      if (value === self.pendingLevelRangeText) return true;
      if (value === self.levelRangeText && self.pendingLevelRangeText === undefined) return true;

      self.excludedGearIds.clear();
      self.pendingLevelRangeText = value;

      return true;
    },
    submitPendingLevelRange(): void {
      if (self.pendingLevelRangeText === undefined) return;

      self.levelRangeText = self.pendingLevelRangeText;
      self.pendingLevelRangeText = undefined;
    },
    setSyncLevel(level: number | undefined, jobLevel: G.JobLevel | undefined): void {
      self.syncLevel = level;
      self.jobLevel = jobLevel ?? self.schema.jobLevel;
    },
    setFilterFocus(filterFocus: FilterFocus) {
      if (self.filterFocus === filterFocus) return;

      self.excludedGearIds.clear();
      self.filterFocus = filterFocus;
    },
    setMateriaOverallActiveTab(activeTab: number) {
      self.materiaOverallActiveTab = activeTab;
    },
    setMateriaDetDhtOptimization(gearMateriaStats: Map<G.GearId, G.Stat[]>): void {
      for (const [gearId, materiaStats] of gearMateriaStats.entries()) {
        const gear = self.gears.get(gearId as any) as IGear;

        for (let i = 0; i < gear.materias.length; i++) {
          const materia = gear.materias[i];
          materia.stat = materiaStats[i];

          if (materia.stat === 'DET' || materia.stat === 'DHT') {
            materia.grade = materia.meldableGrades[0];
          }
        }
      }
    },
    toggleShowAllMaterias(): void {
      self.showAllMaterias = !self.showAllMaterias;
    },
    toggleShowAllFoods(): void {
      self.excludedGearIds.clear();
      self.showAllFoods = !self.showAllFoods;
    },
    toggleShowAllPotions(): void {
      self.excludedGearIds.clear();
      self.showAllPotions = !self.showAllPotions;
    },
    toggleDuplicateToolMateria(): void {
      self.duplicateToolMateria = !self.duplicateToolMateria;
    },
    runGearOptimization(config: GearOptimizationConfig): void {
      self.gearOptimizationRunner?.cancel();
      self.gearOptimizationStatus = {
        status: 'running',
        progress: { phase: '准备候选', current: 0, total: 1 },
      };

      const input = buildGearOptimizationInput(self as IStore);

      self.gearOptimizationRunner = runGearOptimizationInWorker({
        input,
        config,
        onProgress: progress => this.setGearOptimizationProgress(progress),
        onResult: report => this.setGearOptimizationResult(report),
        onError: error => this.setGearOptimizationError(error),
      });
    },
    cancelGearOptimization(): void {
      self.gearOptimizationRunner?.cancel();
      self.gearOptimizationRunner = undefined;
      self.gearOptimizationStatus = { status: 'cancelled' };
    },
    setGearOptimizationProgress(progress: GearOptimizationProgress): void {
      self.gearOptimizationStatus = { status: 'running', progress };
    },
    setGearOptimizationResult(report: GearOptimizationReport): void {
      self.gearOptimizationRunner = undefined;
      self.gearOptimizationStatus = { status: 'done', report };
    },
    setGearOptimizationError(error: string): void {
      self.gearOptimizationRunner = undefined;
      self.gearOptimizationStatus = { status: 'error', error };
    },
    applyGearOptimization(result: GearOptimizationResult): void {
      for (const [slot, gearId] of result.selectedGears) {
        if (self.equippedGears.get(slot.toString()) === undefined) {
          const gear = self.gears.get(gearId.toString());

          if (gear !== undefined) {
            self.equippedGears.set(slot.toString(), gear);
          }
        }
      }

      if (self.equippedGears.get('-1') === undefined && result.foodId !== undefined) {
        const food = self.gears.get(result.foodId.toString());

        if (food !== undefined) {
          self.equippedGears.set('-1', food);
        }
      }

      for (const [gearId, assignments] of result.materiaAssignments) {
        const gear = self.gears.get(gearId.toString()) as IGear | undefined;
        if (gear === undefined) continue;

        for (const assignment of assignments) {
          const materia = gear.materias[assignment.index];

          if (materia !== undefined && materia.stat === undefined) {
            materia.meld(assignment.stat, assignment.grade);
          }
        }
      }
    },
    startEditing(): void {
      self.mode = 'edit';
      self.pendingLevelRangeText = undefined;
      self.excludedGearIds.clear();

      let minLevel = Infinity;
      let maxLevel = -Infinity;

      for (const slot of self.schema.slots) {
        const gear = self.equippedGears.get(slot.slot.toString());

        if (gear !== undefined && slot.levelWeight !== 0 && gear.id !== 17726) {
          if (gear.level < minLevel) minLevel = gear.level;
          if (gear.level > maxLevel) maxLevel = gear.level;
        }
      }

      self.levelRangeText = minLevel === maxLevel
        ? minLevel.toString()
        : `${minLevel}-${maxLevel}`;
    },
    removeGearFromCurrentList(gearId: G.GearId): void {
      const id = Math.abs(gearId) as G.GearId;
      self.excludedGearIds.add(id);

      for (const [key, gear] of self.equippedGears.entries()) {
        if (gear !== undefined && Math.abs(gear.id) === id) {
          self.equippedGears.delete(key);
        }
      }
    },
    resetCurrentList(): void {
      self.gearOptimizationRunner?.cancel();
      self.gearOptimizationRunner = undefined;
      self.gearOptimizationStatus = { status: 'idle' };

      self.equippedGears.clear();

      for (const gear of self.gears.values()) {
        if (gear.isFood || self.excludedGearIds.has(Math.abs(gear.id) as G.GearId)) continue;

        for (const materia of gear.materias) {
          materia.meld(undefined);
        }
      }
    },
    equip(gear: IGearUnion): void {
      const key = gear.slot.toString();

      if (self.equippedGears.get(key) === gear) {
        self.equippedGears.delete(key);
      } else {
        self.equippedGears.set(key, gear);
      }
    },
    setClan(clan: number): void {
      self.clan = clan;
      localStorage.setItem(clanStorageKey, clan.toString());
    },
    toggleTiersShown(): void {
      self.tiersShown = !self.tiersShown;
      localStorage.setItem(tiersShownStorageKey, self.tiersShown.toString());
    },
    autoSelect(): void {
      if (self.loadingStatus === 'loading') return;
      if (!self.autoSelectScheduled) return;

      self.autoSelectScheduled = false;

      for (const [slot, gears] of Object.entries(self.groupedGears)) {
        if (self.equippedGears.get(slot) !== undefined) continue;

        let lastMeldable = gears[gears.length - 1];

        if (lastMeldable === undefined || lastMeldable.isFood || lastMeldable.slot === 17) continue;

        for (let i = gears.length - 1; i >= 0; i--) {
          if ((gears[i] as IGear).materiaAdvanced) {
            lastMeldable = gears[i];
            break;
          }
        }

        if (!lastMeldable.isEquipped) {
          this.equip(lastMeldable);
        }
      }
    },
    unprotect(): void {
      mst.unprotect(self);
    },
  }))
  .actions(self => ({
    afterCreate(): void {
      if (self.job !== undefined && parseLevelRanges(self.levelRangeText) === undefined) {
        self.levelRangeText = `${self.schema.defaultItemLevel[0]}-${self.schema.defaultItemLevel[1]}`;
      }

      for (const gearId of Object.values(self.equippedGears.toJSON())) {
        loadGearDataOfGearId(Math.abs(gearId as G.GearId));
      }

      mobx.autorun(() => {
        const ranges = parseLevelRanges(self.pendingLevelRangeText ?? self.levelRangeText);
        if (ranges === undefined) return;

        for (const [min, max] of ranges) {
          loadGearDataOfLevelRange(min, max);
        }
      });

      mobx.autorun(() => {
        if (self.pendingLevelRangeText !== undefined && !gearDataLoading.get()) {
          self.submitPendingLevelRange();
        }
      });

      mobx.reaction(() => self.filteredIds, self.createGears, { fireImmediately: true });
      mobx.reaction(() => self.autoSelectScheduled && self.groupedGears, self.autoSelect);
    },
  }));

export interface IStore extends mst.Instance<typeof Store> { }

function parseLevelRanges(value: string): [number, number][] | undefined {
  if (!value.trim()) return undefined;

  const parts = value
    .split(/[,，]/)
    .map(part => part.trim())
    .filter(Boolean);

  if (parts.length === 0) return undefined;

  const ranges: [number, number][] = [];

  for (const part of parts) {
    const match = /^(\d+)(?:\s*[-–—~～]\s*(\d+))?$/.exec(part);
    if (match === null) return undefined;

    const a = parseInt(match[1], 10);
    const b = match[2] === undefined ? a : parseInt(match[2], 10);

    ranges.push([
      Math.min(a, b),
      Math.max(a, b),
    ]);
  }

  return ranges;
}

function buildGearOptimizationInput(store: IStore): GearOptimizationInput {
  const candidateSlots = store.schema.slots
    .filter(slot => slot.slot > 0 || slot.slot === -12)
    .map(slot => {
      const equipped = store.equippedGears.get(slot.slot.toString());
      const gears = equipped !== undefined
        ? [equipped]
        : (store.groupedGears[slot.slot] ?? []);

      return {
        slot: slot.slot,
        name: slot.name,
        plans: gears
          .filter((gear): gear is IGear => !gear.isFood)
          .map(gear => buildOptimizerGearInput(store, gear, slot, equipped !== undefined)),
      };
    });

  const equippedFood = store.equippedGears.get('-1');

  const foodCandidates = equippedFood?.isFood
    ? [buildOptimizerFoodInput(equippedFood, true)]
    : Array.from(store.gears.values())
      .filter((gear): gear is IFood =>
        gear.isFood &&
        gear.slot === -1 &&
        'best' in gear.data &&
        !store.excludedGearIds.has(Math.abs(gear.id) as G.GearId))
      .map(food => buildOptimizerFoodInput(food, false));

  return {
    job: store.job!,
    jobLevel: store.jobLevel,
    baseStats: { ...store.baseStats },
    candidateSlots,
    foodCandidates,
    hasEquippedFood: equippedFood?.isFood ?? false,
  };
}

function buildOptimizerGearInput(
  store: IStore,
  gear: IGear,
  slot: G.SlotSchema,
  fixed: boolean,
): OptimizerGearInput {
  const bareStats: G.Stats = {};

  for (const [stat, value] of Object.entries(gear.bareStats) as G.StatPairs) {
    bareStats[gear.concretizeStat(stat)] = value;
  }

  if (gear.customizable) {
    Object.assign(bareStats, gear.customStats!.toJSON());
  }

  const syncedLevel = gear.syncedLevel;
  const materiaStats = gear.materiaStats;

  return {
    id: gear.id,
    name: gear.name,
    level: gear.level,
    slot: slot.slot,
    slotName: slot.name,
    slotWeight: slot.levelWeight ?? 1,
    fixed,
    bareStats,
    caps: { ...gear.caps },
    syncedLevel,
    syncedCaps: syncedLevel !== undefined
      ? G.getCaps(gear.data, syncedLevel)
      : undefined,
    occultStats: gear.data.occultStats,
    materiaSlot: gear.materiaSlot,
    materias: gear.materias.map(materia => {
      const optionGrade = materia.stat === undefined && syncedLevel === undefined
        ? materia.meldableGrades[0]
        : undefined;

      const optionStats = optionGrade !== undefined
        ? store.schema.stats.filter(stat => {
          if (!(stat in G.materias)) return false;

          const materiaValue = G.materias[stat]![optionGrade - 1];

          return (materiaStats[stat] ?? 0) + materiaValue <= gear.totalMeldableStats[stat]!;
        })
        : [];

      return {
        index: materia.index,
        fixedStat: materia.stat,
        fixedGrade: materia.grade,
        optionStats,
        optionGrade,
      };
    }),
  };
}

function buildOptimizerFoodInput(food: IFood, fixed: boolean): OptimizerFoodInput {
  return {
    id: food.id,
    stats: { ...food.stats },
    statRates: { ...food.statRates },
    fixed,
  };
}
