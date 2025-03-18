# Enhanced Canvas

>Designed for heavy user of Obsidian Canvas.

## Overview

This Obsidian plugin enhances Canvas functionality by automatically managing node connections and synchronizing them with note properties.

When you edit in Canvas, the plugin automatically tracks relationships by adding properties named after the canvas file to your notes.

Most importantly, creating edges in Canvas establishes connections visible in the Graph View through markdown links.

## Demo

![enhanced-canvas](./Attachments/demo_with_focus.gif)

- Based on this demo:
  1. **Node addition**: When a note is added to the canvas, the plugin generates a 'canvas' property with a link to its corresponding canvas file.
  2. **Edge addition**: Creating an edge in the Canvas generates a link to the target note within a property named after the canvas file (e.g., 'Canvas 1'), where the property name is derived from the canvas file name without its '.canvas' extension.
  3. **Node Focusing**: Upon clicking a link to a .canvas file from a note, the system automatically focuses and zooms to the associated node in the canvas.

**Note 1**: All Canvas-related properties will be added when this plugin is enabled, and all properties added by this plugin will be removed upon disabling it.

**Note 2**: If you delete or rename a .canvas or Markdown file, all associated properties will also be updated.


## Key Features

- **Automated Property Synchronization**
  - Automatically creates properties in source notes when connecting nodes in Canvas
  - Properties are named after the canvas file to track relationships
  - Supports file nodes, nested Canvas files (.canvas), images, PDFs, and any content that can be represented as markdown links
  - Note: Text nodes (cards) are not supported as they cannot be represented as markdown links
- **Shortest Path Optimization** for node connections
- **Bidirectional Link Management** between Canvas and note content

## Command Features


![demoCommand](./Attachments/demoCommand.gif)

**"Auto Connect Nodes and Adjust Edge with Shortest Path"**
- Automatically establishes connections based on existing markdown links in notes
- Optimizes edge paths in Canvas for minimal distance
- Supports all node types (text nodes, group nodes, images, nested Canvases, etc.)



## Installation Steps

Search for "Enhanced Canvas" in the community plugins and install it. Once enabled, it automatically adds all properties to existing .canvas files.

## Contributing

All contributions are welcome! 

## Say Thank You
If you are enjoying Enhanced Canvas, then please support my work and enthusiasm by buying me a coffee on https://buymeacoffee.com/robertttbs.
