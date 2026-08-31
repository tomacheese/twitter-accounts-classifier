import { describe, expect, it } from 'vitest'
import { extractCardDestinationUrls, type CardLike } from './card-destination-urls'

function unifiedCard(destinationObjects: unknown): CardLike {
  return {
    legacy: {
      bindingValues: [
        {
          key: 'unified_card',
          value: { stringValue: JSON.stringify({ destination_objects: destinationObjects }) },
        },
      ],
    },
  }
}

describe('extractCardDestinationUrls', () => {
  it('trims a single browser destination URL', () => {
    const result = extractCardDestinationUrls(
      unifiedCard({
        browser_1: {
          type: 'browser',
          data: { url_data: { url: '  https://www.example-shop.test/item/FICTIONAL1  ' } },
        },
      }),
    )

    expect(result).toEqual({
      urls: ['https://www.example-shop.test/item/FICTIONAL1'],
      evaluated: true,
    })
  })

  it('dedupes multiple browser destinations pointing at the same URL', () => {
    const result = extractCardDestinationUrls(
      unifiedCard({
        browser_1: {
          type: 'browser',
          data: { url_data: { url: 'https://www.example-shop.test/item/FICTIONAL2' } },
        },
        browser_2: {
          type: 'browser',
          data: { url_data: { url: 'https://www.example-shop.test/item/FICTIONAL2' } },
        },
        browser_3: {
          type: 'browser',
          data: { url_data: { url: 'https://www.example-shop.test/item/FICTIONAL3' } },
        },
      }),
    )

    expect(result).toEqual({
      urls: [
        'https://www.example-shop.test/item/FICTIONAL2',
        'https://www.example-shop.test/item/FICTIONAL3',
      ],
      evaluated: true,
    })
  })

  it('ignores a non-http(s) destination URL', () => {
    const result = extractCardDestinationUrls(
      unifiedCard({
        browser_1: {
          type: 'browser',
          data: { url_data: { url: 'card://internal/component' } },
        },
      }),
    )

    expect(result).toEqual({ urls: [], evaluated: true })
  })

  it('ignores non-browser destinations such as media images', () => {
    const result = extractCardDestinationUrls(
      unifiedCard({
        image_1: {
          type: 'image',
          data: { url_data: { url: 'https://example-shop.test/image.jpg' } },
        },
      }),
    )

    expect(result).toEqual({ urls: [], evaluated: true })
  })

  it('treats an absent card as evaluated with no URLs', () => {
    expect(extractCardDestinationUrls(undefined)).toEqual({ urls: [], evaluated: true })
  })

  it('treats a card without a unified_card binding as evaluated with no URLs', () => {
    const result = extractCardDestinationUrls({
      legacy: {
        bindingValues: [{ key: 'card_url', value: { stringValue: 'https://example-shop.test' } }],
      },
    })

    expect(result).toEqual({ urls: [], evaluated: true })
  })

  it('marks evaluated=false when the unified_card payload fails to JSON parse', () => {
    const result = extractCardDestinationUrls({
      legacy: { bindingValues: [{ key: 'unified_card', value: { stringValue: '{not json' } }] },
    })

    expect(result).toEqual({ urls: [], evaluated: false })
  })

  it('marks evaluated=false when destination_objects has an unexpected shape', () => {
    const result = extractCardDestinationUrls(unifiedCard('unexpected-string-shape'))

    expect(result).toEqual({ urls: [], evaluated: false })
  })
})
