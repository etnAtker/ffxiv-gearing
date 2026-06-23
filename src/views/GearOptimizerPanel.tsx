import * as React from 'react';
import * as mobxReact from 'mobx-react-lite';
import { Button } from './@rmwc/button';
import { TextField } from './@rmwc/textfield';
import { useStore } from './components/contexts';
import type { DropdownPopperProps } from './components/Dropdown';
import type { GearOptimizationConfig, GearOptimizationResult } from '../optimizer/GearOptimizerTypes';

export const GearOptimizerPanel = mobxReact.observer<DropdownPopperProps>(({ toggle }) => {
  const store = useStore();
  const [ minGcd, setMinGcd ] = React.useState('');
  const [ maxGcd, setMaxGcd ] = React.useState(store.equippedEffects?.gcd.toFixed(2) ?? '');
  const [ targetGcd, setTargetGcd ] = React.useState('');
  const [ pruneRatio, setPruneRatio ] = React.useState('99');
  const [ resultLimit, setResultLimit ] = React.useState('5');
  const optimizationStatus = store.gearOptimizationStatus;
  const report = optimizationStatus.status === 'done' ? optimizationStatus.report : undefined;
  const running = optimizationStatus.status === 'running';
  const unavailable = store.schema.mainStat === undefined || store.isViewing;
  const optimize = () => {
    const config: GearOptimizationConfig = {
      minGcd: parseOptionalNumber(minGcd),
      maxGcd: parseOptionalNumber(maxGcd),
      targetGcd: parseOptionalNumber(targetGcd),
      pruneRatio: parseOptionalNumber(pruneRatio),
      resultLimit: parseInt(resultLimit, 10) || 5,
    };
    store.runGearOptimization(config);
  };
  return (
    <div className="gear-optimizer card">
      <div className="gear-optimizer_header">
        <div className="gear-optimizer_title">装备优化</div>
        <div className="gear-optimizer_subtitle">每威力伤害期望最大</div>
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
            <OptimizationResults results={report.results} onApply={result => {
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
  onApply: (result: GearOptimizationResult) => void,
}>(({ results, onApply }) => (
  <table className="gear-optimizer_results table">
    <thead>
    <tr>
      <th>伤害期望</th>
      <th>GCD</th>
      <th>品级</th>
      <th />
    </tr>
    </thead>
    <tbody>
    {results.map((result, i) => (
      <tr key={i}>
        <td>{result.damage.toFixed(5)}</td>
        <td>{result.gcd.toFixed(2)}s</td>
        <td>il{result.equippedLevel}</td>
        <td>
          <Button className="gear-optimizer_apply" onClick={() => onApply(result)}>应用</Button>
        </td>
      </tr>
    ))}
    </tbody>
  </table>
));

function parseOptionalNumber(value: string): number | undefined {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
