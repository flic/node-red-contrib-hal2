# node-red-contrib-hal2 [![npm version](https://badge.fury.io/js/node-red-contrib-hal2.svg)](https://badge.fury.io/js/node-red-contrib-hal2)
A set of nodes to help with basic home automation logic.

**Note:** I've added a few new examples to demonstrate the new functionality in 1.6 and 1.7.

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

The documentation is somewhat lacking at the moment, but take a look at the example flows and Thing definitions in the https://github.com/flic/node-red-contrib-hal2/tree/main/examples folder for more information.

## History

**1.7** Command loopback for virtual Things

**1.6** Thing attributes & filter function added. Thing Cmnd topic parameter changed to a general topic parameter, some changes to Item topic filter and command topic.

**1.5** Item notes added

**1.4** Item filter applied to all node types

**1.3** Dynamically set thing.id at runtime

**1.2** Copy functions from other types

**1.1** Item filter on gate node

**1.0** Initial release