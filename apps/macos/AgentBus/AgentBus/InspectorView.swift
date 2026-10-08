import SwiftUI
import AppKit

struct SessionInspector: View {
    let connection: BusConnection
    let session: CachedSession?
    let clear: () -> Void
    let cost: () -> Void

    var body: some View {
        Form {
            Section("Session") {
                LabeledContent("Channel", value: Channel.name(session?.channel ?? "app"))
                LabeledContent("Topic", value: session?.topic ?? "general")
                LabeledContent("Agent") {
                    Text(connection.health?.agent ?? "—").font(.system(.body, design: .monospaced))
                }
                if let claude = session?.claudeSessionID {
                    LabeledContent("Claude session") {
                        Text(claude).font(.system(.body, design: .monospaced))
                            .lineLimit(1).truncationMode(.middle)
                            .contextMenu {
                                Button("Copy") {
                                    NSPasteboard.general.clearContents()
                                    NSPasteboard.general.setString(claude, forType: .string)
                                }
                            }
                    }
                }
                if let started = session?.started {
                    LabeledContent("Started", value: BusDate.stamp(started))
                }
                if let count = session?.messageCount, count > 0 {
                    LabeledContent("Messages", value: count.formatted())
                }
            }
            Section("Agent slots") {
                if let capacity = connection.capacity, capacity.limit > 0 {
                    SlotBar(capacity: capacity)
                    Text(SlotBar.caption(capacity)).font(.caption).foregroundStyle(.secondary)
                } else {
                    Text("Slot usage is unavailable.").font(.caption).foregroundStyle(.secondary)
                }
            }
            Section {
                HStack {
                    Button("Clear Session…", action: clear)
                    Button("Cost", action: cost)
                }
                .disabled(session?.isEarlier == true)
            }
        }
        .formStyle(.grouped)
        .inspectorColumnWidth(min: 220, ideal: 260, max: 360)
        .task {
            // Activity frames carry capacity too; this keeps it fresh while the turns are quiet.
            while !Task.isCancelled {
                await connection.refreshHealth()
                try? await Task.sleep(for: .seconds(15))
            }
        }
    }
}

/// One segment per agent slot: user turns orange, scheduled work secondary, free slots unfilled.
struct SlotBar: View {
    let capacity: BusCapacity

    var body: some View {
        HStack(spacing: 3) {
            ForEach(0..<max(capacity.limit, 1), id: \.self) { index in
                Capsule().fill(style(index)).frame(height: 8)
            }
        }
        .accessibilityElement()
        .accessibilityLabel("\(capacity.busy) of \(capacity.limit) agent slots busy")
    }

    private func style(_ index: Int) -> AnyShapeStyle {
        if index < capacity.runningUser { return AnyShapeStyle(Color.orange) }
        if index < capacity.busy { return AnyShapeStyle(.secondary) }
        return AnyShapeStyle(.fill.tertiary)
    }

    static func caption(_ capacity: BusCapacity) -> String {
        func plural(_ count: Int, _ word: String) -> String { "\(count) \(word)\(count == 1 ? "" : "s")" }
        var parts = ["\(plural(capacity.runningUser, "user turn")) running"]
        if capacity.runningSystem > 0 { parts.append("\(capacity.runningSystem) scheduled running") }
        if capacity.reservedSystemSlots > 0 {
            parts.append("\(plural(capacity.reservedSystemSlots, "slot")) reserved for scheduled work")
        }
        parts.append("\(capacity.waiting) queued")
        return parts.joined(separator: " · ")
    }
}
