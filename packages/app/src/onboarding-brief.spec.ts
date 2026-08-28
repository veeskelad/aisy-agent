import { describe, expect, it } from 'vitest'

import { liveProviderTools } from './live-network-tool-policy.js'
import { makeOnboardingBrief, renderOnboardingBrief } from './onboarding-brief.js'
import { ONBOARDING_TOPICS, type OnboardingTopic } from './onboarding-progress.js'

describe('onboarding brief', () => {
  it('is present while any topic is unanswered', () => {
    const brief = makeOnboardingBrief({ missing: () => ['autonomy'] })
    expect(brief()).toContain('Первое знакомство')
  })

  it('disappears once every topic is covered', () => {
    expect(makeOnboardingBrief({ missing: () => [] })()).toBeNull()
  })

  it('does not inject unfinished acquaintance into ordinary turns after first contact', () => {
    const brief = makeOnboardingBrief({
      missing: () => ['name', 'work'],
      active: () => false,
    })

    expect(brief()).toBeNull()
  })

  it('can become inactive after the initial contact without closing missing topics', () => {
    let active = true
    const brief = makeOnboardingBrief({
      missing: () => ['autonomy'],
      active: () => active,
    })

    expect(brief()).toContain('Первое знакомство')
    active = false
    expect(brief()).toBeNull()
  })

  it('follows the progress it is given, turn by turn', () => {
    let missing: OnboardingTopic[] = [...ONBOARDING_TOPICS]
    const brief = makeOnboardingBrief({ missing: () => missing })

    expect(brief()).toContain('чем занимается')
    missing = missing.filter((topic) => topic !== 'work')
    expect(brief()).not.toContain('чем занимается')
  })

  it('asks only about what is still missing', () => {
    const rendered = renderOnboardingBrief(['projects', 'expectations'])

    expect(rendered).toContain('какие проекты идут сейчас')
    expect(rendered).toContain('чего ждёт в первую неделю')
    expect(rendered).not.toContain('часовой пояс')
  })

  it('names the topic tag the model has to pass back', () => {
    expect(renderOnboardingBrief(['style'])).toContain('topic: style')
  })

  it('offers the tools the live runtime actually advertises', () => {
    const rendered = renderOnboardingBrief([...ONBOARDING_TOPICS])
    // The live catalog publishes both, so the acquaintance may ask for a link
    // instead of demanding pasted text. Naming a tool that is not there would
    // be instructing the model to fail.
    const live = liveProviderTools().map((tool) => tool.name)
    expect(live).toContain('fetch_url')
    expect(live).toContain('web_search')
    expect(rendered).toContain('fetch_url')
    expect(rendered).toContain('web_search')
  })
})
