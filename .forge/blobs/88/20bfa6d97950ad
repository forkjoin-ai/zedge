; Gnarly topology highlighting

; Edge types -- the heart of the GG family
(edge_type) @keyword.control

; Specific edge type coloring via injections
((edge_type) @keyword.control.fork
 (#eq? @keyword.control.fork "FORK"))
((edge_type) @keyword.control.race
 (#eq? @keyword.control.race "RACE"))
((edge_type) @keyword.control.fold
 (#eq? @keyword.control.fold "FOLD"))
((edge_type) @keyword.control.vent
 (#eq? @keyword.control.vent "VENT"))

; Imperative keywords
(imperative_keyword) @keyword

; Gnarly metadata and embedded implementation blocks
(gnarly_metadata "gnarly" @keyword)

(
  implementation_block
  "impl" @keyword
  (identifier) @function
  "in" @keyword
  (identifier) @type
)

; Node declarations
(node_declaration (identifier) @entity.name)

; Type names
(type_name) @type

; Properties
(property (identifier) @property)

(
  property
  (identifier) @property.special
  (#match? @property.special "^(language|file|callee|candidates|fastest)$")
)

; Strings
(string) @string

; Numbers
(number) @number

; Node references in groups
(node_ref_group (identifier) @variable)

; Edge connector punctuation
(edge_connector) @punctuation.special

; Block braces
(property_block "{" @punctuation.bracket)
(property_block "}" @punctuation.bracket)
(gnarly_metadata "{" @punctuation.bracket)
(gnarly_metadata "}" @punctuation.bracket)
(implementation_body "{" @punctuation.bracket)
(implementation_body "}" @punctuation.bracket)

; Node group parens
(node_ref_group "(" @punctuation.bracket)
(node_ref_group ")" @punctuation.bracket)
(node_declaration "(" @punctuation.bracket)
(node_declaration ")" @punctuation.bracket)

; Pipe separator
(node_ref_group "|" @punctuation.delimiter)

; Comments
(comment) @comment
