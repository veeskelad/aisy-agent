import { describe, it, expect } from 'vitest'
import { isNewerVersion } from './onboarding-node.js'

describe('isNewerVersion', () => {
  it('patch bump is newer', () => {
    expect(isNewerVersion('0.1.1', '0.1.2')).toBe(true)
  })

  it('minor bump is newer', () => {
    expect(isNewerVersion('0.1.9', '0.2.0')).toBe(true)
  })

  it('major bump is newer', () => {
    expect(isNewerVersion('0.9.9', '1.0.0')).toBe(true)
  })

  it('equal versions are not newer', () => {
    expect(isNewerVersion('0.1.0', '0.1.0')).toBe(false)
  })

  it('older candidate is not newer', () => {
    expect(isNewerVersion('1.0.0', '0.9.9')).toBe(false)
  })

  it('patch downgrade is not newer', () => {
    expect(isNewerVersion('0.1.2', '0.1.1')).toBe(false)
  })

  it('minor downgrade is not newer', () => {
    expect(isNewerVersion('0.2.0', '0.1.9')).toBe(false)
  })

  it('same major, same minor, newer patch', () => {
    expect(isNewerVersion('1.2.3', '1.2.4')).toBe(true)
  })

  it('same major, newer minor, lower patch is still newer', () => {
    expect(isNewerVersion('1.2.9', '1.3.0')).toBe(true)
  })
})
