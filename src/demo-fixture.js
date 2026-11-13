(function (root) {
  'use strict';

  var core = (typeof module === 'object' && module.exports) ? require('./core.js') : root.RoomRescueCore;

  var SVG = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="420" viewBox="0 0 640 420">',
    '<rect width="640" height="420" fill="#e8ecf3"/>',
    '<rect x="0" y="300" width="640" height="120" fill="#cfd6e2"/>',
    '<rect x="60" y="230" width="520" height="18" fill="#8a6a4a"/>',
    '<rect x="80" y="248" width="16" height="90" fill="#7a5c40"/>',
    '<rect x="544" y="248" width="16" height="90" fill="#7a5c40"/>',
    '<rect x="110" y="150" width="120" height="80" fill="#c9a06a"/>',
    '<text x="120" y="180" font-family="sans-serif" font-size="13" fill="#3a2c1c">TAX DOCS</text>',
    '<text x="120" y="198" font-family="sans-serif" font-size="13" fill="#3a2c1c">2023</text>',
    '<rect x="250" y="170" width="100" height="60" fill="#b9c4d4"/>',
    '<text x="258" y="196" font-family="sans-serif" font-size="11" fill="#2b3444">CABLES</text>',
    '<text x="258" y="212" font-family="sans-serif" font-size="11" fill="#2b3444">ADAPTERS</text>',
    '<rect x="380" y="120" width="18" height="110" fill="#5f7f9f"/>',
    '<rect x="402" y="132" width="18" height="98" fill="#7f9fbf"/>',
    '<rect x="424" y="126" width="18" height="104" fill="#4f6f8f"/>',
    '<rect x="446" y="140" width="18" height="90" fill="#6f8faf"/>',
    '<rect x="480" y="196" width="46" height="34" rx="6" fill="#f0f2f6" stroke="#b9c4d4"/>',
    '<rect x="500" y="188" width="8" height="10" fill="#b9c4d4"/>',
    '<rect x="150" y="212" width="70" height="18" fill="#fdf6e3" stroke="#d8cba8"/>',
    '<rect x="230" y="216" width="60" height="14" fill="#fdf6e3" stroke="#d8cba8"/>',
    '<rect x="300" y="210" width="54" height="20" fill="#fdf6e3" stroke="#d8cba8"/>',
    '<text x="306" y="224" font-family="sans-serif" font-size="9" fill="#8a7a4a">RETURN FRI</text>',
    '<rect x="60" y="60" width="120" height="70" fill="#dfe4ec" stroke="#b9c4d4"/>',
    '<text x="72" y="100" font-family="sans-serif" font-size="11" fill="#55637a">SHELF</text>',
    '</svg>'
  ].join('');

  var IMAGE_DATA_URL = 'data:image/svg+xml;utf8,' + encodeURIComponent(SVG);

  var OCR_TEXT = ['TAX DOCS', '2023', 'CABLES', 'ADAPTERS', 'RETURN FRI'].join('\n');

  var RAW_PLAN = {
    room_type: 'Home Office',
    clutter_level: 'heavy',
    summary: 'A home-office desk has become a holding area: two cardboard boxes of paperwork, a stack of unread books, loose notes, and a mug crowd the working surface. The shelf above is half empty, which is the fastest place to reclaim space.',
    quick_win: {
      title: 'Clear the centre of the desk surface',
      estimated_minutes: 5,
      why_first: 'The desk is the one surface you use every day. Clearing the middle third gives you an immediate working area and makes the rest of the job feel possible.'
    },
    zones: [
      {
        id: 'z1',
        name: 'Desk surface',
        observation: 'Two boxes, a book stack, three loose notes, and a mug occupy most of the working area.',
        priority: 'high',
        goal_state: 'Only the laptop, a lamp, and one mug remain on the surface.'
      },
      {
        id: 'z2',
        name: 'Shelf above the desk',
        observation: 'The shelf is mostly empty and sits within arm reach.',
        priority: 'medium',
        goal_state: 'Archive boxes and rarely used books live here, labelled and stacked two high.'
      },
      {
        id: 'z3',
        name: 'Floor beside the desk',
        observation: 'A bag and a loose cable run sit on the floor where your chair rolls.',
        priority: 'low',
        goal_state: 'Floor is clear so the chair moves freely.'
      }
    ],
    items: [
      {
        name: 'Tax documents box',
        zone_id: 'z1',
        category: 'paperwork',
        disposition: 'contain',
        source: 'vision_and_ocr',
        suggestion: 'The box is already labelled "TAX DOCS 2023" — put it on the shelf above and keep only the current year within reach.'
      },
      {
        name: 'Cables and adapters box',
        zone_id: 'z1',
        category: 'electronics',
        disposition: 'contain',
        source: 'vision_and_ocr',
        suggestion: 'Sort into one small bin with dividers, then store it in a drawer rather than on the surface.'
      },
      {
        name: 'Book stack',
        zone_id: 'z1',
        category: 'books',
        disposition: 'relocate',
        source: 'vision',
        suggestion: 'Keep the two you are actively reading, shelve the rest.'
      },
      {
        name: 'Loose notes and receipts',
        zone_id: 'z1',
        category: 'paperwork',
        disposition: 'recycle_trash',
        source: 'vision_and_ocr',
        suggestion: 'One note says return by Friday. Act on that one, recycle the rest.'
      },
      {
        name: 'Spare mug',
        zone_id: 'z1',
        category: 'kitchenware',
        disposition: 'relocate',
        source: 'vision',
        suggestion: 'Take it to the kitchen on your next trip out of the room.'
      }
    ],
    action_plan: [
      {
        step_id: 's1',
        zone_id: 'z1',
        action: 'Clear the centre of the desk into a single staging box.',
        priority: 'high',
        impact: 'high',
        estimated_minutes: 5
      },
      {
        step_id: 's2',
        zone_id: 'z1',
        action: 'Sort the staging box into keep, file, and recycle piles.',
        priority: 'high',
        impact: 'high',
        estimated_minutes: 15
      },
      {
        step_id: 's3',
        zone_id: 'z2',
        action: 'Move the \'TAX DOCS 2023\' box onto the shelf above.',
        priority: 'medium',
        impact: 'high',
        estimated_minutes: 2
      },
      {
        step_id: 's4',
        zone_id: 'z1',
        action: 'Shelve the books you are not actively reading.',
        priority: 'medium',
        impact: 'medium',
        estimated_minutes: 2
      },
      {
        step_id: 's5',
        zone_id: 'z3',
        action: 'Coil the loose cables and hang the bag on a hook.',
        priority: 'low',
        impact: 'medium',
        estimated_minutes: 3
      }
    ]
  };

  function getDemoFixture() {
    var ocrSummary = core.normalizeOcrResult({
      pages: [{ index: 0, markdown: OCR_TEXT, confidence_scores: { average_page_confidence_score: 0.91 } }]
    });
    var plan = core.normalizeAndRankPlan(RAW_PLAN, ocrSummary, { isDemo: true });
    return {
      plan: plan,
      imageDataUrl: IMAGE_DATA_URL,
      ocrSummary: ocrSummary
    };
  }

  var api = {
    getDemoFixture: getDemoFixture,
    DEMO_IMAGE_DATA_URL: IMAGE_DATA_URL,
    DEMO_OCR_TEXT: OCR_TEXT
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
  root.RoomRescueDemo = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
