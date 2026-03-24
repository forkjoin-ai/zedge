; Gnosis topology highlighting
; Fork/Race/Fold get distinct colors as the core trinity

; Edge types -- the heart of the language
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

; Node declarations
(node_declaration (identifier) @entity.name)

; Type names
(type_name) @type

; Properties
(property (identifier) @property)

; Strings
(string) @string

; Numbers
(number) @number

; Node references in groups
(node_ref_group (identifier) @variable)

; Edge connector punctuation
(edge_connector) @punctuation.special

; Property block braces
(property_block "{" @punctuation.bracket)
(property_block "}" @punctuation.bracket)

; Node group parens
(node_ref_group "(" @punctuation.bracket)
(node_ref_group ")" @punctuation.bracket)
(node_declaration "(" @punctuation.bracket)
(node_declaration ")" @punctuation.bracket)

; Pipe separator
(node_ref_group "|" @punctuation.delimiter)

; Comments
(comment) @comment
