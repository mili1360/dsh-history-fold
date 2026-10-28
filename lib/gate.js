// 「这句话要不要回忆」分类器的推理：TF-IDF 字符 1-3gram + 逻辑回归，纯 JS 零依赖。
//
// 训练数据是 400 条人工标注（E:\AI_Workspace\retrieval-train\labels-b*.json），
// 用法是【配合规则】而不是替代规则：规则保召回（真题 7/20、零误放），
// 模型过滤规则的误报（真实分布上误报 73/358 -> 52/358，召回零损失）。
//
// 口径必须和训练时严格一致（实测过三处坑）：
//   1. 去掉所有空白
//   2. n = 1,2,3，每个 n 的循环上界 max(1, len-n+1)
//   3. 不做 lowercase —— sklearn 在 analyzer 是自定义函数时会跳过 lowercase 预处理，
//      所以训练时的 char_ngrams 收到的是原始大小写文本（GGUF 切出 U/G/F 而不是 uf/gu）
import fs from 'node:fs'
import path from 'node:path'

let cached = null

export function loadGate(modelFile) {
    if (cached && cached.file === modelFile) return cached.model
    let raw
    try { raw = fs.readFileSync(modelFile, 'utf8') } catch { return null }
    let json
    try { json = JSON.parse(raw) } catch { return null }
    const map = new Map()
    for (const f of json.features) map.set(f.g, [f.w, f.idf])
    const model = { intercept: json.intercept, map }
    cached = { file: modelFile, model }
    return model
}

export function charGrams(text) {
    const s = String(text).replace(/\s+/g, '')
    const out = []
    for (const n of [1, 2, 3]) {
        const lim = Math.max(1, s.length - n + 1)
        for (let i = 0; i < lim; i++) out.push(s.slice(i, i + n))
    }
    return out
}

export function gateProb(model, text) {
    if (!model) return null
    const tf = new Map()
    for (const g of charGrams(text)) if (model.map.has(g)) tf.set(g, (tf.get(g) || 0) + 1)
    if (!tf.size) return 1 / (1 + Math.exp(-model.intercept))
    let norm = 0
    const vals = []
    for (const [g, c] of tf) {
        const v = c * model.map.get(g)[1]
        vals.push([g, v])
        norm += v * v
    }
    norm = Math.sqrt(norm) || 1
    let acc = 0
    for (const [g, v] of vals) acc += (v / norm) * model.map.get(g)[0]
    return 1 / (1 + Math.exp(-(acc + model.intercept)))
}

// 插件入口：模型缺失时静默返回 null（调用方当作"没有额外意见"处理，规则照常生效）
export function makeGate(opts = {}) {
    const threshold = typeof opts.threshold === 'number' ? opts.threshold : 0.45
    const modelFile = opts.modelFile || path.join(import.meta.dirname || '.', '..', 'model', 'gate-model.json')
    const model = loadGate(modelFile)
    return {
        available: !!model,
        threshold,
        // 规则已经说"该查"时，再用模型否决它（只在模型非常确信是噪声时否决）
        allow(text) {
            if (!model) return true
            const p = gateProb(model, text)
            return p === null ? true : p >= threshold
        },
        prob(text) {
            return model ? gateProb(model, text) : null
        },
    }
}

