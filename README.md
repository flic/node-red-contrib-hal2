# node-red-contrib-hal [![npm version](https://badge.fury.io/js/node-red-contrib-hal.svg)](https://badge.fury.io/js/node-red-contrib-hal)
A set of nodes to help with basic home automation logic.

**Note:** Breaking changes between 0.x and 1.x! The Topic filter value on all Item nodes and Item value on Event nodes needs to be manually updated.

## Install
```bash
cd ~/.node-red
npm install node-red-contrib-hal
```

## What is it?
**node-red-contrib-hal** is a set of Node-RED nodes useful for creating home automation flows. The basic component is the Item node, used for keeping the state of an item. This state can then be used to trigger events, route traffic based on rules and more.

1. Store an incoming value in an **Item node**
2. Fire an event when the value changes using an **Event node**
3. One or more rules will compare the value and that of other Items in a **Gate node**
4. Output the value to another flow with a **Value node**
5. Output multiple Item values, one after another, using a **Bundle node**

## Messaging format

The **Item node** will always save the whole incoming *msg*, so it's possible to output different properties from different **Value nodes**.

The **Item node** will also add the following properties:
```javascript
msg.payload = {
    topic: 'xxx',           //(optional) a Topic identifier
    name: 'Item name'       //The Item Name parameter
}
```
