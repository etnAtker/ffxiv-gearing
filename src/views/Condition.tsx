import * as React from 'react';
import * as mobxReact from 'mobx-react-lite';
import classNames from 'clsx';
import { Button } from './@rmwc/button';
import { TextField } from './@rmwc/textfield';
import { Badge } from './@rmwc/badge';
import { useStore } from './components/contexts';
import { RippleLazy } from './components/RippleLazy';
import { Icon } from './components/Icon';
import { Dropdown } from './components/Dropdown';
import { BadgeButton } from './components/BadgeButton';
import { JobSelector } from './JobSelector';
import { FilterPanel } from './FilterPanel';
import { LevelSyncPanel } from './LevelSyncPanel';
import { MateriaOverallPanel } from './MateriaOverallPanel';
import { GearOptimizerPanel } from './GearOptimizerPanel';
import { SharePanel } from './SharePanel';
import { ImportPanel } from './ImportPanel';
import { SettingPanel } from './SettingPanel';

declare const __PATCH__: string;

export const Condition = mobxReact.observer(() => {
  const store = useStore();
  const welcoming = store.job === undefined;
  const editing = !store.isViewing && store.job !== undefined;
  const viewing = store.isViewing && store.job !== undefined;
  return (
    <div className="condition card" style={store.job === undefined ? { width: '900px' } : {}}>
      {welcoming && (
        <span className="condition_job -empty">选择一个职业开始配装</span>
      )}
      {welcoming && (
        <a
          className={classNames('condition_tip', store.promotion.get('legacyLink') && '-highlight')}
          href="./ew/"
          children="此工具已适配至《金曦之遗辉》资料片，如需使用《晓月之终途》版本请点击此处"
          onClick={store.promotion.get('legacyLink') ? () => store.promotion.off('legacyLink') : undefined}
          onMouseLeave={store.promotion.get('legacyLink') ? () => store.promotion.off('legacyLink') : undefined}
        />
      )}
      {editing && (
        <Dropdown
          label={({ ref, toggle }) => (
            <RippleLazy>
              <span ref={ref} className="condition_job" onClick={toggle}>
                <Icon className="condition_job-icon" name={'jobs/' + store.job} />
                <span className="condition_job-name">{store.schema.name}</span>
              </span>
            </RippleLazy>
          )}
          popper={() => (
            <div className="job-select-panel card">
              <JobSelector />
              <div className="job-select-panel_tip">
                中键点击职业（或右键菜单-在新标签页中打开链接）可新建一份空白配装
              </div>
            </div>
          )}
          placement="bottom-start"
          modifiers={[{ name: 'offset', options: { offset: [-4, 0] } }]}
        />
      )}
      {viewing && (
        <span className="condition_job">
          <Icon className="condition_job-icon" name={'jobs/' + store.job} />
          <span className="condition_job-name">{store.schema.name}</span>
        </span>
      )}
      {editing && <span className="condition_divider" />}
      {editing && (
        <span className="condition_level">
          <span className="condition_level-value">
            <ConditionLevelRangeInput
              value={store.pendingLevelRangeText ?? store.levelRangeText}
              onChange={value => store.setLevelRangeText(value)}
            />
          </span>
          品级
          <span
            className="condition_level-tip"
            aria-label="格式如：“720-735, 790, 795”"
            role="tooltip"
            data-tooltip-position="bottom"
            children={<Icon name="help" />}
          />
        </span>
      )}
      {editing && (
        <Dropdown
          label={({ ref, toggle }) => (
            <BadgeButton
              ref={ref}
              className="condition_button condition_filter"
              promotion="filter"
              onClick={toggle}
              children="筛选"
            />
          )}
          popper={FilterPanel}
          placement="bottom-start"
        />
      )}
      {(editing || viewing) && <span className="condition_divider" />}
      {viewing && store.schema.levelSyncable && store.syncLevelText !== undefined && (
        <>
          <span className="condition_text">
            <Icon className="condition_level-sync-icon" name="sync" />
            {store.syncLevelText}
          </span>
          <span className="condition_divider" />
        </>
      )}
      {editing && store.schema.levelSyncable && (
        <Dropdown
          label={({ ref, toggle }) => (
            <Button ref={ref} className="condition_button" onClick={toggle}>
              {store.syncLevelText !== undefined && <Icon className="condition_level-sync-icon" name="sync" />}
              {store.syncLevelText ?? '品级同步'}
            </Button>
          )}
          popper={LevelSyncPanel}
          placement="bottom-start"
        />
      )}
      {(editing || viewing) && (
        <Dropdown
          label={({ ref, toggle }) => (
            <Button ref={ref} className="condition_button badge-button" onClick={toggle}>
              魔晶石
              <Badge
                className="badge-button_badge"
                exited={store.isViewing || !store.promotion.get('materiaDetDhtOptimization')}
              />
            </Button>
          )}
          popper={MateriaOverallPanel}
          placement="bottom-start"
        />
      )}
      {editing && store.schema.mainStat !== undefined && (
        <Dropdown
          label={({ ref, toggle }) => (
            <Button ref={ref} className="condition_button" onClick={toggle}>装备优化</Button>
          )}
          popper={GearOptimizerPanel}
          placement="bottom-start"
        />
      )}
      {editing && (
        <Button
          className="condition_button"
          onClick={store.resetCurrentList}
          children="重置"
        />
      )}
      <span className="condition_right">
        {editing && (
          <Dropdown
            label={({ ref, toggle }) => (
              <Button ref={ref} className="condition_button" onClick={toggle}>分享</Button>
            )}
            popper={SharePanel}
            placement="bottom-end"
          />
        )}
        {(welcoming || editing) && (
          <Dropdown
            label={({ ref, toggle }) => (
              <Button ref={ref} className="condition_button" onClick={toggle}>导入</Button>
            )}
            popper={ImportPanel}
            placement="bottom-end"
          />
        )}
        {viewing && (
          <Button
            className="condition_button"
            onClick={() => {
              store.startEditing();
              window.history.pushState(null, document.title, window.location.href.replace(/\?.*$/, ''));
            }}
            children="编辑"
          />
        )}
        {(editing || viewing) && (
          <Dropdown
            label={({ ref, toggle }) => (
              <Button ref={ref} className="condition_button condition_setting" onClick={toggle}>设置</Button>
            )}
            popper={SettingPanel}
            placement="bottom-end"
          />
        )}
        <span className="condition_divider" />
        <span className="condition_text">数据版本 {__PATCH__}</span>
      </span>
      {welcoming && <JobSelector />}
      {welcoming && (
        <a
          href="https://www.bilibili.com/video/BV1pt4y1W7pX"
          title="【视频】如何自助配装？高难本配装原理详解"
          target="_blank"
        >
          <img
            className="condition_welcome-promotion"
            src={require('../../img/BV1pt4y1W7pX.png')}
            srcSet={require('../../img/BV1pt4y1W7pX@2x.png') + ' 2x'}
            alt=""
          />
        </a>
      )}
    </div>
  );
});

const ConditionLevelRangeInput = mobxReact.observer<{
  value: string,
  onChange: (value: string) => boolean,
}>(({ value, onChange }) => {
  const [inputValue, setInputValue] = React.useState(value);
  const [prevValue, setPrevValue] = React.useState(value);

  if (value !== prevValue) {
    setInputValue(value);
    setPrevValue(value);
  }

  const commit = () => {
    if (!onChange(inputValue)) {
      setInputValue(value);
    }
  };

  return (
    <TextField
      className="condition_level-input mdc-text-field--compact"
      type="text"
      value={inputValue}
      placeholder="730-735, 755, 775-800"
      onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
        setInputValue(e.target.value);
      }}
      onFocus={e => e.target.select()}
      onBlur={commit}
      onKeyDown={e => {
        if (e.key === 'Enter') {
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
});
