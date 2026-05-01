/**
 * Tree-sitter grammar for Gnosis (.gg / .ggl / .gnarly)
 *
 * Gnosis is a graph topology language where:
 * - Nodes are declared as: (name: Type { prop: 'value' })
 * - Edges connect nodes:   (source)-[:EDGE_TYPE]->(target)
 * - Fork/Race/Fold/Vent are the core edge types
 * - Pipe groups:           (a | b | c)
 */

module.exports = grammar({
  name: 'gnosis',

  extras: ($) => [/\s/, $.comment],

  rules: {
    source_file: ($) => repeat($._statement),

    _statement: ($) =>
      choice(
        $.gnarly_metadata,
        $.implementation_block,
        $.node_declaration,
        $.edge_declaration,
        $.imperative_statement
      ),

    gnarly_metadata: ($) =>
      seq(
        'gnarly',
        optional($.string),
        '{',
        repeat(choice($.metadata_assignment, $.comment)),
        '}'
      ),

    metadata_assignment: ($) =>
      seq($.identifier, '=', choice($.string, $.identifier, $.array)),

    implementation_block: ($) =>
      seq(
        'impl',
        $.identifier,
        'in',
        $.identifier,
        '{',
        repeat(choice($.implementation_text, $.comment)),
        '}'
      ),

    implementation_text: ($) => /[^{}]+/,

    // Node declaration: (name: Type { prop: 'value', prop2: 'value2' })
    node_declaration: ($) =>
      seq(
        '(',
        $.identifier,
        optional(seq(':', $.type_name)),
        optional($.property_block),
        ')'
      ),

    // Edge: (source)-[:EDGE_TYPE { props }]->(target)
    // Also: (source)-[:EDGE_TYPE]->(target | target2 | target3)
    edge_declaration: ($) =>
      seq($.node_ref_group, $.edge_connector, $.node_ref_group),

    // Edge connector: -[:TYPE { props }]->
    edge_connector: ($) =>
      seq('-[', ':', $.edge_type, optional($.property_block), ']->'),

    // Edge types -- the core of fork/race/fold
    edge_type: ($) =>
      choice(
        'FORK',
        'RACE',
        'FOLD',
        'VENT',
        'PROCESS',
        'COLLAPSE',
        'TUNNEL',
        'INTERFERE',
        'MEASURE',
        'HALT',
        'EVOLVE',
        'ENTANGLE',
        'SUPERPOSE',
        'OBSERVE',
        'METACOG',
        'SLIVER',
        'LAMINAR',
        $.identifier // Custom edge types
      ),

    // Imperative statements (standalone keywords)
    imperative_statement: ($) =>
      seq(
        $.imperative_keyword,
        optional($.identifier),
        optional($.property_block)
      ),

    imperative_keyword: ($) =>
      choice(
        'FORK',
        'RACE',
        'FOLD',
        'VENT',
        'PROCESS',
        'COLLAPSE',
        'TUNNEL',
        'INTERFERE',
        'MEASURE',
        'HALT',
        'EVOLVE',
        'ENTANGLE',
        'SUPERPOSE',
        'OBSERVE',
        'METACOG'
      ),

    // Node reference group: (a) or (a | b | c)
    node_ref_group: ($) =>
      seq('(', $.identifier, repeat(seq('|', $.identifier)), ')'),

    // Property block: { key: 'value', key2: 'value2' }
    property_block: ($) =>
      seq(
        '{',
        optional(seq($.property, repeat(seq(',', $.property)), optional(','))),
        '}'
      ),

    property: ($) => seq($.identifier, ':', $._value),

    _value: ($) => choice($.string, $.number, $.array, $.identifier),

    array: ($) =>
      seq(
        '[',
        optional(seq($._value, repeat(seq(',', $._value)), optional(','))),
        ']'
      ),

    // String: 'text' or "text"
    string: ($) => choice(seq("'", /[^']*/, "'"), seq('"', /[^"]*/, '"')),

    // Number
    number: ($) => /\d+(\.\d+)?/,

    // Type name (PascalCase typically)
    type_name: ($) => /[A-Z][A-Za-z0-9_]*/,

    // Identifier
    identifier: ($) => /[a-zA-Z_][a-zA-Z0-9_]*/,

    // Comments
    comment: ($) =>
      choice(seq('//', /.*/), seq('/*', /[^*]*\*+([^/*][^*]*\*+)*/, '/')),
  },
});
