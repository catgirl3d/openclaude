import { PassThrough } from 'node:stream'

import { expect, test } from 'bun:test'
import React from 'react'
import stripAnsi from 'strip-ansi'

import { createRoot } from '../ink.js'
import type { ResolvedAgent } from '../tools/AgentTool/agentDisplay.js'
import { AgentsList } from './agents/AgentsList.js'

const SYNC_START = '\x1B[?2026h'
const SYNC_END = '\x1B[?2026l'

function extractLastFrame(output: string): string {
  let lastFrame: string | null = null
  let cursor = 0

  while (cursor < output.length) {
    const start = output.indexOf(SYNC_START, cursor)
    if (start === -1) break

    const contentStart = start + SYNC_START.length
    const end = output.indexOf(SYNC_END, contentStart)
    if (end === -1) break

    const frame = output.slice(contentStart, end)
    if (frame.trim().length > 0) {
      lastFrame = frame
    }
    cursor = end + SYNC_END.length
  }

  return lastFrame ?? output
}

function normalizeFrame(output: string): string {
  return stripAnsi(output).replace(/\s+/g, ' ').trim()
}

async function waitForNormalizedFrame(
  getOutput: () => string,
  predicate: (frame: string) => boolean,
  options?: { timeoutMs?: number; intervalMs?: number },
): Promise<string> {
  const timeoutMs = options?.timeoutMs ?? 2000
  const intervalMs = options?.intervalMs ?? 10
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    const frame = normalizeFrame(extractLastFrame(getOutput()))
    if (predicate(frame)) {
      return frame
    }
    await Bun.sleep(intervalMs)
  }

  const lastFrame = normalizeFrame(extractLastFrame(getOutput()))
  throw new Error(`Timed out waiting for frame. Last frame:\n${lastFrame}`)
}

function createTestStreams(): {
  stdout: PassThrough
  stdin: PassThrough & {
    isTTY: boolean
    setRawMode: (mode: boolean) => void
    ref: () => void
    unref: () => void
  }
  getOutput: () => string
} {
  let output = ''
  const stdout = new PassThrough()
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean
    setRawMode: (mode: boolean) => void
    ref: () => void
    unref: () => void
  }

  stdin.isTTY = true
  stdin.setRawMode = () => {}
  stdin.ref = () => {}
  stdin.unref = () => {}
  ;(stdout as unknown as { columns: number }).columns = 120
  stdout.on('data', chunk => {
    output += chunk.toString()
  })

  return {
    stdout,
    stdin,
    getOutput: () => output,
  }
}

function createPluginAgent(agentType: string): ResolvedAgent {
  return {
    agentType,
    whenToUse: 'Used for regression testing',
    source: 'plugin',
    plugin: 'codex',
    getSystemPrompt: () => '',
    baseDir: 'plugin/codex',
    model: 'inherit',
  } as ResolvedAgent
}

test('AgentsList keeps keyboard navigation working after the first move', async () => {
  const { stdout, stdin, getOutput } = createTestStreams()
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })

  try {
    root.render(
      <AgentsList
        source="all"
        agents={[createPluginAgent('codex:codex-rescue')]}
        onBack={() => {}}
        onSelect={() => {}}
        onCreateNew={() => {}}
      />,
    )

    const initialFrame = await waitForNormalizedFrame(getOutput, frame =>
      frame.includes('❯ Create new agent'),
    )
    expect(initialFrame).toContain('❯ Create new agent')

    stdin.write('\x1b[B')
    const downFrame = await waitForNormalizedFrame(getOutput, frame =>
      frame.includes('❯ codex:codex-rescue'),
    )
    expect(downFrame).toContain('❯ codex:codex-rescue')

    stdin.write('\x1b[A')
    const finalFrame = await waitForNormalizedFrame(getOutput, frame =>
      frame.includes('❯ Create new agent') &&
      !frame.includes('❯ codex:codex-rescue'),
    )

    expect(finalFrame).toContain('❯ Create new agent')
    expect(finalFrame).not.toContain('❯ codex:codex-rescue')
  } finally {
    root.unmount()
    stdin.end()
    stdout.end()
    await Bun.sleep(25)
  }
})
