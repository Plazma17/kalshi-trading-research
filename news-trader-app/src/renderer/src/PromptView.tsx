import { useEffect, useState } from 'react'
import type { InstructionSet } from '@shared/schema'

export default function PromptView(): JSX.Element {
  const [systemPrompt, setSystemPrompt] = useState('')
  const [defaultPrompt, setDefaultPrompt] = useState('')
  const [activeId, setActiveId] = useState('')
  const [sets, setSets] = useState<InstructionSet[]>([])
  const [compiled, setCompiled] = useState<{ system: string; fewShotCount: number }>({
    system: '',
    fewShotCount: 0
  })
  const [busy, setBusy] = useState(false)
  const [flash, setFlash] = useState('')

  function note(m: string): void {
    setFlash(m)
    setTimeout(() => setFlash(''), 1500)
  }

  async function refresh(): Promise<void> {
    const [p, list, comp] = await Promise.all([
      window.api.promptGet(),
      window.api.tuningList(),
      window.api.promptCompiled()
    ])
    setSystemPrompt(p.systemPrompt)
    setDefaultPrompt(p.defaultPrompt)
    setActiveId(p.activeInstructionSetId)
    setSets(list)
    setCompiled(comp)
  }
  useEffect(() => {
    refresh()
  }, [])

  async function savePrompt(v: string): Promise<void> {
    await window.api.promptSave(v)
    note('saved')
    setCompiled(await window.api.promptCompiled())
  }

  async function compile(): Promise<void> {
    setBusy(true)
    try {
      const set = await window.api.tuningCompile()
      note(`compiled v${set.version}`)
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  async function activate(id: string): Promise<void> {
    await window.api.tuningActivate(id)
    setActiveId(id)
    note(id ? 'activated' : 'deactivated')
    setCompiled(await window.api.promptCompiled())
  }

  const active = sets.find((s) => s.id === activeId)

  return (
    <div className="body promptview">
      <div className="lbl block">SYSTEM PROMPT (how the AI reasons & outputs)</div>
      <textarea
        className="promptbox"
        value={systemPrompt}
        placeholder={`(empty = built-in default)\n\n${defaultPrompt}`}
        spellCheck={false}
        onChange={(e) => setSystemPrompt(e.target.value)}
        onBlur={(e) => savePrompt(e.target.value)}
      />
      <div className="actions">
        <button className="ghost" onClick={() => savePrompt('')}>
          RESET TO DEFAULT
        </button>
        {flash && <span className="ok flash">{flash}</span>}
      </div>

      <div className="lbl block mt">
        INSTRUCTION SET (compiled from your TUNING-tab feedback, injected into the prompt)
      </div>
      <div className="actions">
        <button onClick={compile} disabled={busy}>
          {busy ? 'COMPILING…' : 'COMPILE FROM FEEDBACK'}
        </button>
        <button className="ghost" onClick={() => activate('')} disabled={!activeId}>
          USE NONE
        </button>
      </div>

      <table className="sig mt">
        <thead>
          <tr>
            <th>VERSION</th>
            <th>WHEN</th>
            <th>FROM LABELS</th>
            <th>GUIDELINES</th>
            <th>EXAMPLES</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {sets.length === 0 && (
            <tr>
              <td colSpan={6} className="dim">
                none yet — label headlines on the TUNING tab, then compile
              </td>
            </tr>
          )}
          {[...sets].reverse().map((s) => (
            <tr key={s.id}>
              <td className="topic">
                v{s.version} {s.id === activeId && <span className="ok">● ACTIVE</span>}
              </td>
              <td className="dim">{s.createdAt.slice(0, 16).replace('T', ' ')}</td>
              <td>{s.sourceFeedbackCount}</td>
              <td>{s.guidelines.length}</td>
              <td>{s.fewShotExamples.length}</td>
              <td>
                {s.id !== activeId && (
                  <button className="segbtn" onClick={() => activate(s.id)}>
                    ACTIVATE
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {active && active.guidelines.length > 0 && (
        <>
          <div className="lbl block mt">ACTIVE GUIDELINES</div>
          <ul className="guidelines">
            {active.guidelines.map((g, i) => (
              <li key={i}>{g}</li>
            ))}
          </ul>
        </>
      )}

      <div className="lbl block mt">
        COMPILED PROMPT SENT TO THE MODEL{' '}
        {compiled.fewShotCount > 0 && <span className="dim">+ {compiled.fewShotCount} few-shot examples</span>}
      </div>
      <pre className="compiled">{compiled.system}</pre>
    </div>
  )
}
