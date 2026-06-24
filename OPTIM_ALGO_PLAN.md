可以，而且我会把优化重点放在 **“静态 skyline/Pareto 构建” + “魔晶石局部方案去排列化” + “后缀可行性/上界剪枝”** 这三块。你现在每个 speed 桶 7000+ 就卡，根因不是 7000 个状态多，而是桶内 Pareto 构建目前是在线二重比较：每来一个状态都先 `frontier.some(...)` 查是否被支配，再反向扫描 frontier 删除被它支配的旧状态。代码里正是这个结构。([GitHub][1]) 文档里也已经指出 5000 个状态最坏会接近 2500 万次比较；7000 个就是约 4900 万次，乘上多个桶和多个装备位，很容易卡。([GitHub][2])

## 结论先说

**最优先改：把 `buildParetoFrontier` 从在线 O(N²) 改成离线 skyline/maxima 算法。**

当前每个 speed 桶的复杂度近似是：

```text
O(N² * d)
```

其中 `N` 是桶内状态数，`d` 是收益属性维度。

可以改成：

```text
d = 2: O(N log N)，甚至排序后近似 O(N)
d = 3: O(N log N)
d = 4: O(N log² N)
d = 5: O(N log³ N)
```

这是同一个 Pareto frontier 问题的算法层优化，不改变结果正确性。经典问题叫 “maxima of a set of vectors” 或 skyline/maximal points；Kung、Luccio、Preparata 的 JACM 论文就是这个问题的早期经典算法。([哈佛大学电子工程与计算机科学系][3])

对你这个场景，收益维度表面上可能有主属性、武器性能、暴击、直击、信念、坚韧等，但很多维度在某些阶段其实是常量。比如装备固定只调魔晶石时，主属性和武器性能通常完全不变，真正参与 skyline 的只有 CRT/DET/DHT/TEN/SKS 或 SPS 中的非 speed 收益属性。所以实际有效维度经常只有 3 到 4。

---

## 1. 把桶内 Pareto 改成“离线 skyline”，这是最大收益点

你现在的 `pruneStates` 先按精确 speed 分桶，再对每个桶做分数阈值剪枝和 Pareto frontier。代码结构是 `bySpeed` 分桶后调用 `buildParetoFrontier`。([GitHub][1]) 问题在于 `buildParetoFrontier` 是在线插入式 frontier：每个新状态都和已有 frontier 比较，最坏就是平方级。([GitHub][1])

应该改成：**一个桶里的状态已经全部生成了，所以不要在线插入；直接把这个桶当成静态点集求 maximal points。**

每个状态就是一个点：

```text
point = [
  mainStat,
  weaponDamage,
  CRT,
  DET,
  DHT,
  TEN,
  ...
]
```

支配关系是：

```text
A dominates B
⇔ A 在所有收益属性上 >= B
且至少一个收益属性 > B
```

然后对这个静态点集求 skyline。

### d=3 的具体做法

假设有效收益维度是：

```text
CRT, DET, DHT
```

要最大化三维。

算法：

```text
1. 按 CRT 降序排序。
2. DET 做坐标压缩。
3. 用 Fenwick tree / segment tree 维护：
   在 DET >= 当前 DET 的范围内，已经见过的最大 DHT。
4. 扫描每个状态：
   如果 query(DET..maxDET) >= 当前 DHT，则当前状态被支配。
   否则保留，并 update(DET, DHT)。
5. 相同 CRT 的状态要按 group 处理，避免自己组内顺序造成误判。
```

复杂度：

```text
O(N log N)
```

7000 个点大概就是 7000 次查询和更新，不再是 4900 万次多属性比较。

### d=4 的具体做法

假设有效收益维度是：

```text
CRT, DET, DHT, TEN
```

可以：

```text
1. 按 CRT 降序扫。
2. 对 DET、DHT 建二维 Fenwick / range tree。
3. 每个节点维护最大 TEN。
4. 查询 DET >= 当前 DET 且 DHT >= 当前 DHT 的区域里最大 TEN。
```

复杂度：

```text
O(N log² N)
```

即使 7000 个点，`log²N` 也只是百级量级，和 N² 不是一个数量级。

### 落地时建议先做三件事

第一，先 canonicalize：

```text
相同收益属性向量的状态，只保留 changeCount / materiaCount 更优的代表。
```

这一步尤其重要。你的 `dominatesState` 在收益属性完全相等时才比较 changeCount 和 materiaCount。([GitHub][1]) 但如果两个状态所有收益属性完全相同，它们对后续伤害没有区别；搜索阶段通常只需要一个代表。

第二，每个 bucket 内先删掉常量维度：

```text
effectiveDims = benefitStats.filter(dim => 这个 bucket 内 dim 不是常量)
```

这会直接降低 skyline 算法维度。维度从 5 降到 3，复杂度可能从 `O(N log³N)` 变成 `O(N logN)`。

第三，保留一个小桶 fallback：

```text
if bucket.length < 64:
    用当前 O(N²) 朴素算法
else:
    用 skyline index
```

这不是为了本质性能，而是避免小数据结构建索引的常数开销。

---

## 2. 魔晶石局部方案不要按“孔排列”枚举，要按“计数/最终属性向量”生成

这是第二个非常大的算法层优化。

你现在 `enumerateMateriaAssignments` 是逐孔递归枚举，每个孔遍历可选魔晶石。代码里就是对 `options[index]` 递归，最后 `ret.push(current.slice())`。([GitHub][1]) 这意味着 5 个孔、4 种属性时会生成：

```text
4^5 = 1024
```

但如果这 5 个孔的可选 grade 和 stat 集合相同，最终装备属性只取决于：

```text
CRT 放了几颗
DET 放了几颗
DHT 放了几颗
SKS/SPS 放了几颗
```

而不是“第几个孔放了什么”。排列顺序对最终属性没影响。

这时真正不同的分配数量是多重组合：

```text
C(s + m - 1, m - 1)
```

5 孔、4 属性：

```text
C(8, 3) = 56
```

也就是从 1024 降到 56，约 18 倍缩小。
如果是 5 孔、6 属性：

```text
6^5 = 7776
C(10, 5) = 252
```

约 31 倍缩小。

更关键的是，这会连锁减少后面的全局状态数和 Pareto 桶大小。

### 推荐局部生成方式

不要先枚举全部 assignment 再 dedupe。应该直接用局部 DP 生成唯一最终属性向量：

```text
frontier = { gear.bareStats }

for each empty materia slot group:
    next = {}
    for state in frontier:
        for stat in allowedStats:
            newStats = applyMateriaWithCap(state, stat, grade)
            key = finalStatsVector(newStats)
            next[key] = bestCanonicalAssignmentFor(key)
    frontier = localPareto(next)

return frontier
```

如果孔是同质的，可以更进一步按计数枚举：

```text
for cCRT + cDET + cDHT + cSKS = socketCount:
    apply counts with caps
    emit unique final stat vector
```

如果孔不是同质的，就按 group：

```text
group key = (optionGrade, optionStats)
```

同一个 group 内用计数，不同 group 之间做小 DP。

这个改动对“装备固定，只优化魔晶石”的场景尤其有效。你文档里提到装备固定后魔晶石仍然会指数爆炸；这里就是针对这个爆炸源头下手。([GitHub][2])

---

## 3. 用 suffix speed bitset 替代“剩余最大 speed”剪枝

你现在的 speed 可行性剪枝主要是：

```text
nextSpeed > maxSpeed => 丢弃
nextSpeed + remainingMaxSpeed < minSpeed => 丢弃
```

代码里 `calculateRemainingMaxSpeeds` 只算每个后缀部位最多能提供多少 speed。([GitHub][1]) 这很弱，因为它只知道“最大能到多少”，不知道“能不能刚好落进 GCD/speed 窗口”。

应该预计算后缀可达 speed 集合：

```text
suffixReach[i] = 从第 i 个 slot 到最后，所有可能 speed 增量的 bitset
```

递推：

```text
suffixReach[last + 1] = bitset{0}

suffixReach[i] = OR over planSpeed in uniqueSpeeds(slot i):
                     suffixReach[i + 1] << planSpeed
```

搜索时：

```text
needLow  = allowedMinSpeed - currentSpeed
needHigh = allowedMaxSpeed - currentSpeed

if suffixReach[i + 1] 在 [needLow, needHigh] 区间没有任何 bit:
    丢弃
```

复杂度大概是：

```text
O(slotCount * uniquePlanSpeedsPerSlot * speedWidth / wordSize)
```

speedWidth 通常几千，bitset 很便宜。

这个剪枝是**精确且安全**的，比 `remainingMaxSpeed` 强很多。它可以提前删掉大量“理论最大够，但实际组合凑不到目标 speed 区间”的状态。

---

## 4. 用“后缀上界”做安全剪枝，替代裸分 pruneRatio

文档里已经指出，现在的目标阈值剪枝用的是“不含食品”的分数，而最终排序用“含食品”的分数，所以可能误删裸分低但吃食品后反超的状态。([GitHub][2]) 代码里食品确实是在最终 `finalizeResults` 阶段才枚举和计算。([GitHub][1])

建议把 `pruneRatio` 降级成“近似模式”，精确模式改成 upper bound：

```text
remainingMaxStats[i][stat] =
    从第 i 个 slot 到最后，每个 stat 能取得的组件级最大值之和
```

对一个 partial state：

```text
optimisticStats = currentStats + remainingMaxStats[i + 1]
optimisticBestDamage = max over foods:
    damage(applyFood(optimisticStats, food))
```

如果：

```text
optimisticBestDamage < 当前第 K 名结果伤害
```

就可以安全剪枝。

这是安全的原因是：它对剩余装备/魔晶石做了“各属性独立取最大”的乐观估计，实际任何后缀都不可能在每个收益属性上超过这个向量。只要伤害函数对收益属性单调，这个 upper bound 就不会低估真实最优。

为了让这个剪枝更早生效，可以先跑一个很小的 greedy/beam 取得初始 incumbent。这个 beam 不作为最终答案，只用来提供剪枝阈值。

---

## 5. 把两个戒指位合成一个 super-slot

这个看起来像小改，但其实是算法建模层面的改动。

现在状态里需要 `hasUsedItemId` 来避免重复使用同一物品，主要影响两个戒指位。代码中每次合并都会沿前驱链检查 itemId。([GitHub][1]) 但更深的问题是：**如果 Pareto 比较忽略“未来哪些 item 不能用了”，那么在处理第一个戒指后，两个状态即使 speed 和 stats 可比较，也不一定有相同的未来可选集合。**

更稳的做法是直接把戒指变成一个组合部位：

```text
ringPairPlans = {
    (ringA, ringB) | itemIdA != itemIdB
}
```

也就是搜索时不再有“戒指1”和“戒指2”两个阶段，而是一个“戒指对”阶段。

好处：

```text
1. 去掉 path-dependent itemId 约束。
2. Pareto dominance 重新只依赖 stats/speed，逻辑更干净。
3. 后续 suffixReach 和 cross-speed dominance 更容易做对。
4. hasUsedItemId 基本可以从热路径消失。
```

戒指候选数量一般不大，组合成 pair 的成本通常远小于保留路径依赖带来的复杂性。

---

## 6. 可以做安全的跨 speed 剪枝，但要基于“后缀可行性集合”

文档里说当前按精确 speed 分桶，因为不同 speed 的状态不完全等价。这个判断是对的；粗暴按 GCD 档分桶会误删。([GitHub][2])

但可以做一个更强且安全的跨 speed 支配关系。

在处理到第 i 个 slot 时，定义：

```text
F_i(s) = suffixReach[i] ∩ [allowedMinSpeed - s, allowedMaxSpeed - s]
```

也就是“当前 speed 为 s 时，后缀还能用哪些 speed 增量完成 GCD 约束”。

那么状态 A 可以跨 speed 支配状态 B，当且仅当：

```text
A.stats >= B.stats
且 F_i(B.speed) ⊆ F_i(A.speed)
```

含义是：任何能让 B 完成 GCD 的后缀 speed，拿给 A 也能完成；同时 A 的收益属性不低于 B，所以 A 后续接同一个 suffix 不会更差。

实现上 `F_i(s)` 就是 bitset slice。判断子集：

```text
(F_B & ~F_A) == 0
```

这个可以作为第二阶段剪枝：

```text
1. 先做同 speed 桶内 skyline。
2. 再按 suffix feasibility mask 做跨 speed skyline。
```

注意：这个优化最好在“戒指 super-slot”之后做，否则 future availability 不只由 speed 决定，还可能由已使用 itemId 决定。

---

## 7. 推荐落地顺序

我会按这个顺序改：

```text
第一步：局部魔晶石方案去排列化
```

先把同质孔从 `m^s` 改成计数/局部 DP。这个会直接减少 localPlans 和后续状态。

```text
第二步：戒指合成 super-slot
```

去掉 itemId 路径依赖，让 DP 状态更适合 Pareto 支配。

```text
第三步：把 buildParetoFrontier 换成离线 skyline
```

这是解决 7000 speed 桶卡顿的核心。目标是让每个桶从 O(N²) 变成 O(N log^k N)。

```text
第四步：suffix speed bitset
```

用精确可达性剪枝替换 `remainingMaxSpeed` 这种弱剪枝。

```text
第五步：food-aware upper bound
```

把 `pruneRatio` 从精确模式里移出去，改成安全上界剪枝；`pruneRatio` 可以作为“快速近似模式”。

```text
第六步：跨 speed residual mask dominance
```

在前面几步稳定后再做。这个收益取决于具体 speed 分布，但它是当前“只能同 speed 比较”的自然升级版。

---

## 复杂度变化总结

当前核心瓶颈：

```text
每轮合并后：
  Σ speedBucket O(N_bucket² * d)
```

改完 skyline 后：

```text
每轮合并后：
  Σ speedBucket O(N_bucket log^(d_eff - 2) N_bucket)
```

其中 `d_eff` 是去掉常量维度后的有效收益维度。

局部魔晶石：

```text
当前：O(m^s)
改后：同质孔 O(C(s + m - 1, m - 1))
```

speed 可行性：

```text
当前：只用 min/max，剪枝弱
改后：bitset 精确可达，O(width / wordSize) 查询
```

整体精确搜索的最坏情况仍然可能很大，因为 Pareto frontier 本身可能形成巨大 antichain；但你的“7000 一个桶就卡”的直接问题，主要是 frontier 构建算法的平方级复杂度。把这一层换掉后，7000 桶应该从“明显卡”变成很普通的规模。

[1]: https://github.com/etnAtker/ffxiv-gearing/blob/gear-auto-optim/src/optimizer/GearOptimizer.ts "ffxiv-gearing/src/optimizer/GearOptimizer.ts at gear-auto-optim · etnAtker/ffxiv-gearing · GitHub"
[2]: https://raw.githubusercontent.com/etnAtker/ffxiv-gearing/refs/heads/gear-auto-optim/OPTIM_ALGO.md "raw.githubusercontent.com"
[3]: https://www.eecs.harvard.edu/~htk/publication/1975-jacm-kung-luccio-preparata.pdf?utm_source=chatgpt.com "On Finding the Maxima of a Set of Vectors - Harvard University"
