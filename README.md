# node-red-contrib-hal2 [![npm version](https://badge.fury.io/js/node-red-contrib-hal2.svg)](https://badge.fury.io/js/node-red-contrib-hal2)
A set of nodes to help with basic home automation logic.

**Note:** Even more new examples added

## Install
```bash
cd ~/.node-red
npm install node-red-contrib-hal2
```

## What is it?
**node-red-contrib-hal2** is a set of Node-RED nodes useful for creating home automation flows. The basic component is the Thing node, a virtual representation of a (usually) physical IoT device. This can then be used to trigger events, route traffic based on rules and more.

1. Store a device state in a **Thing node**
2. Fire an event when the value changes using an **Event node**
3. One or more rules will compare the value and that of other Items in a **Gate node**
4. Output the value to another flow with a **Value node**
5. Send device commands to multiple Things using an **Action node**

Take a look at the example flows and Thing definitions in the https://github.com/flic/node-red-contrib-hal2/tree/main/examples folder for more information.

## History

**1.11**<br>
New options for Gate rules: Time Since Update and Time Since Change.<br>
It's now possible to use a function to create dynamic status text strings for Items.<br>
Value and Item node output includes last_update and last_change epoch date.<br>
New examples.

**1.10**<br>
Export and import Thingtypes using the Node-RED Library function.<br>
Minimum node version bumped to >=14, minimum Node-RED version bumped to >= 2.2.0. 

**1.9**<br>
It's now possible to configure multiple outputs on the Thing node and use a specific output per command.

**1.8**<br>
Value node can update Item values

**1.7**<br>
Command loopback for virtual Things

**1.6**<br>
Thing attributes & filter function added.<br>
Thing Cmnd topic parameter changed to a general topic parameter, some changes to Item topic filter and command topic.

**1.5**<br>
Item notes added

**1.4**<br>
Item filter applied to all node types

**1.3**<br>
Dynamically set thing.id at runtime

**1.2**<br>
Copy functions from other types

**1.1**<br>
Item filter on gate node

**1.0**<br>
Initial release