export type Step = {
  index: number
  checked: boolean
  text: string
  offset: number
  line: number
}

/** Source offsets preserve the original line endings and all surrounding prose. */
export function getSteps(markdown: string): Step[] {
  const steps: Step[] = []
  let offset = 0
  let fence: string | null = null
  let lineNumber = 1
  for (const line of markdown.split(/(?<=\n)/)) {
    const content = line.replace(/\r?\n$/, '')
    const fenceMatch = content.match(/^ {0,3}([`~])\1{2,}/)
    if (fenceMatch) {
      if (fence === fenceMatch[1]) fence = null
      else if (!fence) fence = fenceMatch[1]
    }
    const match = !fence && content.match(/^([ \t]*(?:[-+*]|\d+[.)])\s+\[)([ xX])(\]\s+)(.*)$/)
    if (match) {
      steps.push({
        index: steps.length,
        checked: match[2].toLowerCase() === 'x',
        text: match[4],
        offset: offset + match[1].length,
        line: lineNumber,
      })
    }
    offset += line.length
    lineNumber++
  }
  return steps
}

export function toggleStep(markdown: string, index: number, checked: boolean) {
  const step = getSteps(markdown)[index]
  if (!step) throw new Error('检查步骤不存在，请刷新后重试。')
  return markdown.slice(0, step.offset) + (checked ? 'x' : ' ') + markdown.slice(step.offset + 1)
}

export function parseHeading(heading: string) {
  const match = heading.match(/^(\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2})?前?)\s+(.+)$/)
  return match ? { dateText: match[1], title: match[2] } : { dateText: '', title: heading }
}

export function compareTasks(a: { dateText?: string; sortOrder?: number }, b: { dateText?: string; sortOrder?: number }) {
  const aDate = a.dateText || ''
  const bDate = b.dateText || ''
  if (aDate && !bDate) return -1
  if (!aDate && bDate) return 1
  const dateOrder = aDate.replace(/前$/, '').localeCompare(bDate.replace(/前$/, ''))
  return dateOrder || (a.sortOrder || 0) - (b.sortOrder || 0)
}

export function parseTasks(markdown: string) {
  const tasks: Array<{ dateText: string; title: string; status: string; bodyMarkdown: string; sortOrder: number }> = []
  let status: string | null = null
  let current: { dateText: string; title: string; status: string; bodyMarkdown: string; sortOrder: number } | null = null
  function finish() {
    if (current) {
      current.bodyMarkdown = current.bodyMarkdown.replace(/^(?:\r?\n)+|(?:\r?\n)+$/g, '')
      tasks.push(current)
      current = null
    }
  }
  for (const line of markdown.split(/(?<=\n)/)) {
    const content = line.replace(/\r?\n$/, '')
    if (/^## (待处理|已完成)\s*$/.test(content)) {
      finish()
      status = content.includes('已完成') ? 'completed' : 'pending'
    } else if (status && /^### /.test(content)) {
      finish()
      current = { ...parseHeading(content.slice(4).trim()), status, bodyMarkdown: '', sortOrder: tasks.length }
    } else if (current) current.bodyMarkdown += line
  }
  finish()
  return tasks
}

export function parseNotes(markdown: string) {
  const content = markdown.replace(/^# 随手记\r?\n/, '').replace(/^(\r?\n)*## 随手记录\r?\n/, '').trim()
  if (!content) return []
  const blocks = content.split(/^### /m)
  const notes: Array<{ title: string; bodyMarkdown: string }> = []
  if (blocks[0].trim()) notes.push({ title: '随手记录', bodyMarkdown: blocks[0].trim() })
  for (const block of blocks.slice(1)) {
    const firstBreak = block.indexOf('\n')
    notes.push({
      title: (firstBreak < 0 ? block : block.slice(0, firstBreak)).trim(),
      bodyMarkdown: firstBreak < 0 ? '' : block.slice(firstBreak + 1).trim(),
    })
  }
  return notes
}
