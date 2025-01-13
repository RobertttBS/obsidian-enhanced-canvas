# Obsidian - Enhanced Canvas
## Overview

This Obsidian plugin enhances Canvas functionality by automatically managing node connections and synchronizing them with note properties. 

When you edit in Canvas, the plugin automatically tracks relationships by adding properties named after the canvas file to your notes. 

Most importantly, creating edges in Canvas establishes connections visible in the Graph View through markdown links.

![enhanced-canvas](./Attachments/enhanced-canvas.png)

- Based on this screenshot:
  1. When adding a node to the canvas, it creates a 'canvas' property containing a link to the corresponding canvas file.
  2. Similarly, creating an edge in the Canvas generates an 'Untitled' property with a link to "Note B". The property name is "Untitled" without ".canvas" extension.
  3. These markdown links within properties are then reflected in the Local Graph View.

Note: The property icon for 'canvas' is customized using the "File Property Enhancer" plugin.

## Key Features

- **Automated Property Synchronization**
  - Automatically creates properties in source notes when connecting nodes in Canvas
  - Properties are named after the canvas file to track relationships
  - Supports file nodes, nested Canvas files (.canvas), images, PDFs, and any content that can be represented as markdown links
  - Note: Text nodes (cards) are not supported as they cannot be represented as markdown links
- **Shortest Path Optimization** for node connections
- **Bidirectional Link Management** between Canvas and note content

## Command Features

**"Auto Connect Nodes and Adjust Edge with Shortest Path"**
- Automatically establishes connections based on existing markdown links in notes
- Optimizes edge paths in Canvas for minimal distance
- Supports all node types (text nodes, group nodes, images, nested Canvases, etc.)

## Use Cases

- In addition to the edges in Canvas, nodes in Canvas will trigger property updates.

### 1. Creating Edges in Canvas
When connecting nodes (e.g., NoteA to NoteB):
- Automatically adds the target node's link to the source node's properties
- Property name is based on the canvas filename
- Supports images, nested Canvas nodes, and other markdown-link compatible nodes

![CreateEdge](./Attachments/CreateEdge.gif)


### 2. Deleting Edges in Canvas
When removing a Canvas edge:
- Automatically removes the corresponding link from the source note's canvas-specific property
- Preserves existing markdown links within note content

![DeleteEdge](./Attachments/DeleteEdge.gif)

### 3. Updating Edge Endpoints
When modifying edge connections:
- Automatically updates the source node's canvas-specific properties
- Maintains bidirectional consistency between Canvas visualization and property links

![UpdateEdge](./Attachments/UpdateEdge.gif)

### 4. Canvas Command Usage
The **"Auto connect nodes and adjust edges with shortest path"** command:
- Optimizes existing edges between selected nodes for shortest paths
- Creates new Canvas edges based on markdown link relationships
- Particularly useful after moving nodes to maintain optimal connections

![CommandUsage](./Attachments/CommandUsage.gif)

### 5. Canvas File Opening
When opening a Canvas file:
- Automatically updates canvas-specific properties for all file nodes
- Property names are generated based on the canvas filename
- Enables easy property synchronization through simple file opening

![OpenCanvas](./Attachments/OpenCanvas.gif)

### 6. Canvas File Deletion
When deleting a Canvas file:
- Automatically removes associated canvas-specific properties from all notes
- Cleans up all properties named after the deleted canvas

![DeleteCanvas](./Attachments/DeleteCanvas.gif)

### 7. Canvas File Renaming
When renaming a Canvas file:
- Automatically updates property names in all associated notes
- Renames properties to match the new canvas filename
- Preserves all existing relationships under the new property name

![RenameCanvas](./Attachments/RenameCanvas.gif)



## Manual Installation Steps

### 1. Create Plugin Directory
- Create a new folder in your plugins directory: `<vault>/.obsidian/plugins/`
  (where `<vault>` is your Obsidian vault root directory)
- Complete path example: `<vault>/.obsidian/plugins/obsidian-enhanced-canvas/`

### 2. Download Required Files
Download the following files from the plugin's GitHub Release page and place them in the newly created folder:

Required files:
- `main.js` - Main plugin code
- `manifest.json` - Plugin configuration file
Optional file:
- `styles.css` - Custom stylesheet

### 3. Restart Obsidian
- Close and reopen Obsidian

### 4. Enable the Plugin
- Open Settings
- Navigate to Community plugins
- Locate the installed plugin in the list
- Toggle the switch to enable the plugin

## Notes

### Source files
- You can obtain the plugin files through either:
  	- Download from the plugin's GitHub Release page
	- Build from source: Clone the repository and compile it yourself
		- `npm i` (Node.js and npm are prerequisites)
		- `npm run dev`

### Property icons

- Using the "File Property Enhancer" plugin to edit property icons will make the properties in "Enhanced Canvas" look better.


## Contributing

All contributions are welcome! 

## Say Thank You
If you are enjoying Enhanced Canvas, then please support my work and enthusiasm by buying me a coffee on https://buymeacoffee.com/robertttbs.
