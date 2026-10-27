import Foundation

/// The result of inserting a line break into the composer draft.
struct NewlineEdit: Equatable {
    var text: String
    /// Number of characters before the insertion point, so it can be rebuilt as an index into `text`.
    var caretOffset: Int

    var caret: String.Index { text.index(text.startIndex, offsetBy: caretOffset) }
}

enum NewlineInsertion {
    /// Replaces the selected ranges with "\n" and puts the insertion point after it. A collapsed
    /// range inserts at the caret. With no selection the newline goes at the end of the text.
    /// Several ranges (a multi-selection) collapse to one newline at the first range.
    static func insert(into text: String, replacing ranges: [Range<String.Index>]) -> NewlineEdit {
        let ranges = ranges.sorted { $0.lowerBound < $1.lowerBound }
        guard let first = ranges.first else {
            return NewlineEdit(text: text + "\n", caretOffset: text.count + 1)
        }
        var result = text
        for range in ranges.reversed() { result.removeSubrange(range) }
        let offset = text.distance(from: text.startIndex, to: first.lowerBound)
        result.insert("\n", at: result.index(result.startIndex, offsetBy: offset))
        return NewlineEdit(text: result, caretOffset: offset + 1)
    }
}
