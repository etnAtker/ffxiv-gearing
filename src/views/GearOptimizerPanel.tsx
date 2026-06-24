import * as React from 'react';
import * as mobxReact from 'mobx-react-lite';
import { Button } from './@rmwc/button';
import { TextField } from './@rmwc/textfield';
import { useStore } from './components/contexts';
import type { DropdownPopperProps } from './components/Dropdown';
import type { GearOptimizationConfig, GearOptimizationResult } from '../optimizer/GearOptimizerTypes';

type GearOptimizationObjectiveType = 'damage' | 'mitigationEfficiency';

interface GearOptimizerPanelState {
  minGcd?: string,
  maxGcd?: string,
  targetGcd?: string,
  pruneRatio: string,
  resultLimit: string,
  objectiveType: GearOptimizationObjectiveType,
  resultObjectiveType: GearOptimizationObjectiveType,
  theoreticalMaxDamage?: string,
  minTenMitigation: string,
}

const gearOptimizerPanelState: GearOptimizerPanelState = {
  pruneRatio: '99.5',
  resultLimit: '5',
  objectiveType: 'damage',
  resultObjectiveType: 'damage',
  minTenMitigation: '',
};

export const GearOptimizerPanel = mobxReact.observer<DropdownPopperProps>(({ toggle }) => {
  const store = useStore();
  const defaultGcd = store.equippedEffects?.gcd.toFixed(2) ?? '';
  const defaultDamage = store.equippedEffects?.damage.toFixed(5) ?? '';
  const [ minGcd, setMinGcdState ] = React.useState(gearOptimizerPanelState.minGcd ?? defaultGcd);
  const [ maxGcd, setMaxGcdState ] = React.useState(gearOptimizerPanelState.maxGcd ?? defaultGcd);
  const [ targetGcd, setTargetGcdState ] = React.useState(gearOptimizerPanelState.targetGcd ?? defaultGcd);
  const [ pruneRatio, setPruneRatioState ] = React.useState(gearOptimizerPanelState.pruneRatio);
  const [ resultLimit, setResultLimitState ] = React.useState(gearOptimizerPanelState.resultLimit);
  const [ objectiveType, setObjectiveTypeState ] =
    React.useState<GearOptimizationObjectiveType>(gearOptimizerPanelState.objectiveType);
  const [ resultObjectiveType, setResultObjectiveTypeState ] =
    React.useState<GearOptimizationObjectiveType>(gearOptimizerPanelState.resultObjectiveType);
  const [ theoreticalMaxDamage, setTheoreticalMaxDamageState ] =
    React.useState(gearOptimizerPanelState.theoreticalMaxDamage ?? defaultDamage);
  const [ minTenMitigation, setMinTenMitigationState ] = React.useState(gearOptimizerPanelState.minTenMitigation);
  const optimizationStatus = store.gearOptimizationStatus;
  const report = optimizationStatus.status === 'done' ? optimizationStatus.report : undefined;
  const running = optimizationStatus.status === 'running';
  const unavailable = store.schema.mainStat === undefined || store.isViewing;
  const supportsTenacity = store.schema.stats.includes('TEN');
  const setMinGcd = (value: string) => {
    gearOptimizerPanelState.minGcd = value;
    setMinGcdState(value);
  };
  const setMaxGcd = (value: string) => {
    gearOptimizerPanelState.maxGcd = value;
    setMaxGcdState(value);
  };
  const setTargetGcd = (value: string) => {
    gearOptimizerPanelState.targetGcd = value;
    setTargetGcdState(value);
  };
  const setPruneRatio = (value: string) => {
    gearOptimizerPanelState.pruneRatio = value;
    setPruneRatioState(value);
  };
  const setResultLimit = (value: string) => {
    gearOptimizerPanelState.resultLimit = value;
    setResultLimitState(value);
  };
  const setResultObjectiveType = (type: GearOptimizationObjectiveType) => {
    gearOptimizerPanelState.resultObjectiveType = type;
    setResultObjectiveTypeState(type);
  };
  const setTheoreticalMaxDamage = (value: string) => {
    gearOptimizerPanelState.theoreticalMaxDamage = value;
    setTheoreticalMaxDamageState(value);
  };
  const setMinTenMitigation = (value: string) => {
    gearOptimizerPanelState.minTenMitigation = value;
    setMinTenMitigationState(value);
  };
  const setOptimizationObjectiveType = (type: GearOptimizationObjectiveType) => {
    gearOptimizerPanelState.objectiveType = type;
    setObjectiveTypeState(type);
    if (type === 'mitigationEfficiency') {
      setPruneRatio('30');
    } else {
      setPruneRatio('99.5');
    }
  };
  const optimize = () => {
    const selectedObjectiveType = supportsTenacity ? objectiveType : 'damage';
    const config: GearOptimizationConfig = {
      minGcd: parseOptionalNumber(minGcd),
      maxGcd: parseOptionalNumber(maxGcd),
      targetGcd: parseOptionalNumber(targetGcd),
      pruneRatio: parseOptionalNumber(pruneRatio),
      resultLimit: parseInt(resultLimit, 10) || 5,
      objective: buildObjectiveConfig(selectedObjectiveType, theoreticalMaxDamage, minTenMitigation),
    };
    setResultObjectiveType(selectedObjectiveType);
    store.runGearOptimization(config);
  };
  return (
    <div className="gear-optimizer card">
      <div className="gear-optimizer_header">
        <div className="gear-optimizer_title">装备优化</div>
        <div className="gear-optimizer_subtitle">{getObjectiveSubtitle(supportsTenacity ? objectiveType : 'damage')}</div>
      </div>
      {unavailable ? (
        <div className="gear-optimizer_message">装备优化仅支持编辑中的战斗职业。</div>
      ) : (
        <>
          <div className="gear-optimizer_controls">
            <label className="gear-optimizer_field">
              <span>GCD下限</span>
              <TextField
                className="gear-optimizer_input mdc-text-field--compact"
                disabled={running}
                type="number"
                step="0.01"
                value={minGcd}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setMinGcd(e.target.value)}
              />
            </label>
            <label className="gear-optimizer_field">
              <span>GCD上限</span>
              <TextField
                className="gear-optimizer_input mdc-text-field--compact"
                disabled={running}
                type="number"
                step="0.01"
                value={maxGcd}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setMaxGcd(e.target.value)}
              />
            </label>
            <label className="gear-optimizer_field">
              <span>目标GCD</span>
              <TextField
                className="gear-optimizer_input mdc-text-field--compact"
                disabled={running}
                type="number"
                step="0.01"
                value={targetGcd}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTargetGcd(e.target.value)}
              />
            </label>
            <label className="gear-optimizer_field">
              <span>结果数</span>
              <TextField
                className="gear-optimizer_input mdc-text-field--compact"
                disabled={running}
                type="number"
                step="1"
                value={resultLimit}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setResultLimit(e.target.value)}
              />
            </label>
            <label className="gear-optimizer_field -wide">
              <span>剪枝阈值</span>
              <TextField
                className="gear-optimizer_input mdc-text-field--compact"
                disabled={running}
                type="number"
                step="0.1"
                suffix="%"
                value={pruneRatio}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPruneRatio(e.target.value)}
              />
            </label>
            {supportsTenacity && (
              <>
                <label className="gear-optimizer_field -wide">
                  <span>优化目标</span>
                  <select
                    className="gear-optimizer_select"
                    disabled={running}
                    value={objectiveType}
                    onChange={(e: React.ChangeEvent<HTMLSelectElement>) => {
                      setOptimizationObjectiveType(e.target.value as GearOptimizationObjectiveType);
                    }}
                  >
                    <option value="damage">最高伤害期望</option>
                    <option value="mitigationEfficiency">目标减伤率</option>
                  </select>
                </label>
                {objectiveType === 'mitigationEfficiency' && (
                  <label className="gear-optimizer_field -wide">
                    <span>参考期望</span>
                    <TextField
                      className="gear-optimizer_input mdc-text-field--compact"
                      disabled={running}
                      type="number"
                      step="0.00001"
                      value={theoreticalMaxDamage}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTheoreticalMaxDamage(e.target.value)}
                    />
                  </label>
                )}
                {objectiveType === 'mitigationEfficiency' && (
                  <label className="gear-optimizer_field -wide">
                    <span>目标减伤率</span>
                    <TextField
                      className="gear-optimizer_input mdc-text-field--compact"
                      disabled={running}
                      type="number"
                      step="0.01"
                      suffix="%"
                      value={minTenMitigation}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => setMinTenMitigation(e.target.value)}
                    />
                  </label>
                )}
              </>
            )}
          </div>
          <div className="gear-optimizer_actions">
            <Button className="gear-optimizer_optimize" disabled={running} onClick={optimize}>
              {running ? '计算中' : '优化'}
            </Button>
            {running && (
              <Button className="gear-optimizer_cancel" onClick={store.cancelGearOptimization}>取消</Button>
            )}
          </div>
          {optimizationStatus.status === 'running' && (
            <Progress progress={optimizationStatus.progress} />
          )}
          {optimizationStatus.status === 'cancelled' && (
            <div className="gear-optimizer_message">优化已取消。</div>
          )}
          {optimizationStatus.status === 'error' && (
            <div className="gear-optimizer_message">{optimizationStatus.error}</div>
          )}
          {report?.error !== undefined && (
            <div className="gear-optimizer_message">{report.error}</div>
          )}
          {report !== undefined && report.results.length > 0 && (
            <OptimizationResults results={report.results} objectiveType={resultObjectiveType} onApply={result => {
              store.applyGearOptimization(result);
              toggle();
            }} />
          )}
        </>
      )}
    </div>
  );
});

const Progress = mobxReact.observer<{
  progress: { phase: string, current: number, total: number, states?: number },
}>(({ progress }) => (
  <div className="gear-optimizer_progress">
    <div className="gear-optimizer_progress-title">{progress.phase}</div>
    <div className="gear-optimizer_progress-line">
      {progress.current}/{progress.total}
      {progress.states !== undefined && `，状态 ${progress.states}`}
    </div>
    <div className="gear-optimizer_progress-bar">
      <div
        className="gear-optimizer_progress-value"
        style={{ width: `${progress.total > 0 ? progress.current / progress.total * 100 : 0}%` }}
      />
    </div>
  </div>
));

const OptimizationResults = mobxReact.observer<{
  results: GearOptimizationResult[],
  objectiveType: GearOptimizationObjectiveType,
  onApply: (result: GearOptimizationResult) => void,
}>(({ results, objectiveType, onApply }) => {
  const showTenacity = results.some(result => result.tenMitigation > 0);
  const showObjectiveScore = objectiveType === 'mitigationEfficiency';
  return (
  <table className="gear-optimizer_results table">
    <thead>
    <tr>
      <th>伤害期望</th>
      {showTenacity && <th>减伤率</th>}
      {showObjectiveScore && <th>伤害转换率</th>}
      <th>GCD</th>
      <th>品级</th>
      <th />
    </tr>
    </thead>
    <tbody>
    {results.map((result, i) => (
      <tr key={i}>
        <td>{result.damage.toFixed(5)}</td>
        {showTenacity && <td>{formatPercent(result.tenMitigation)}</td>}
        {showObjectiveScore && <td>{formatObjectiveScore(result)}</td>}
        <td>{result.gcd.toFixed(2)}s</td>
        <td>il{result.equippedLevel}</td>
        <td>
          <Button className="gear-optimizer_apply" onClick={() => onApply(result)}>应用</Button>
        </td>
      </tr>
    ))}
    </tbody>
  </table>
  );
});

function buildObjectiveConfig(
  type: GearOptimizationObjectiveType,
  theoreticalMaxDamage: string,
  minTenMitigation: string,
): GearOptimizationConfig['objective'] {
  switch (type) {
    case 'mitigationEfficiency':
      return {
        type: 'mitigationEfficiency',
        theoreticalMaxDamage: parseOptionalNumber(theoreticalMaxDamage) ?? 0,
        minTenMitigation: parseOptionalPercent(minTenMitigation),
      };
    case 'damage':
    default:
      return { type: 'damage' };
  }
}

function parseOptionalPercent(value: string): number | undefined {
  const parsed = parseOptionalNumber(value);
  return parsed === undefined ? undefined : parsed / 100;
}

function getObjectiveSubtitle(type: GearOptimizationObjectiveType): string {
  switch (type) {
    case 'mitigationEfficiency':
      return '减伤率不低于目标且伤害转换率最高';
    case 'damage':
    default:
      return '每威力伤害期望最大';
  }
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function formatObjectiveScore(result: GearOptimizationResult): string {
  return result.objectiveScore.toFixed(6);
}

function parseOptionalNumber(value: string): number | undefined {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
